# RetroFM Boom Box Playback Controls: Source Code Review & Technical Audit

This document is an evidence-based code review of the RetroFM Boom Box playback control system. It details the exact current implementation of the Play, Pause, Stop, Rewind, Fast Forward, Volume, and Balance paths across the three browser tabs (Boom Box, RetroFM Web App, and YouTube), quoting exact source lines and analyzing state flows.

---

## 1. Current Git Status and Working Tree Diff

### 1.1 `git status --short`
```
 M extension/background.js
 M extension/content_retrofm.js
 M extension/manifest.json
 M extension/player/player.css
 M extension/player/player.js
 M package.json
 M src/App.tsx
 M src/services/extensionBundle.ts
 M src/services/music/YouTubeMusicProvider.ts
?? scripts/test-boombox-integration.ts
```

### 1.2 Target Files Diff Summary
- `extension/content_youtube.js`: **No diff** (identical to git HEAD).
- `extension/player/index.html`: **No diff** (identical to git HEAD).
- `scripts/test-boombox-integration.ts`: **Untracked** (new automated test suite added in workspace).
- `src/App.tsx`: **Modified** (see diff below).
- `src/services/music/YouTubeMusicProvider.ts`: **Modified** (see diff below).
- `extension/background.js`: **Modified** (see diff below).
- `extension/player/player.css`: **Modified** (see diff below).
- `extension/player/player.js`: **Modified** (see diff below).

### 1.3 Complete Git Diff for Modified Files

#### `src/services/music/YouTubeMusicProvider.ts`
```diff
diff --git a/src/services/music/YouTubeMusicProvider.ts b/src/services/music/YouTubeMusicProvider.ts
index a2ce46e..629f126 100644
--- a/src/services/music/YouTubeMusicProvider.ts
+++ b/src/services/music/YouTubeMusicProvider.ts
@@ -8,6 +8,8 @@ export class YouTubeMusicProvider implements MusicProvider {
   private isExtensionDetected = false;
   private reportedExtensionVersion: string | null = null;
   private messageCounter = 0;
+  private boomBoxActionListeners: Set<(action: any) => void> = new Set();
+  private stateRequestListeners: Set<() => void> = new Set();
 
   constructor() {
     if (typeof window !== 'undefined') {
@@ -17,6 +19,16 @@ export class YouTubeMusicProvider implements MusicProvider {
           if (event.data.version) {
             this.reportedExtensionVersion = event.data.version;
           }
+          if (event.data.type === 'BOOMBOX_ACTION' && event.data.payload) {
+            for (const listener of this.boomBoxActionListeners) {
+              try { listener(event.data.payload); } catch (e) {}
+            }
+          }
+          if (event.data.type === 'GET_RADIO_STATE_REQUEST') {
+            for (const listener of this.stateRequestListeners) {
+              try { listener(); } catch (e) {}
+            }
+          }
         }
       });
       // Send initial ping to check if extension is already active
@@ -178,6 +190,39 @@ export class YouTubeMusicProvider implements MusicProvider {
     }
   }
 
+  public onBoomBoxAction(callback: (action: any) => void): () => void {
+    this.boomBoxActionListeners.add(callback);
+    return () => {
+      this.boomBoxActionListeners.delete(callback);
+    };
+  }
+
+  public onRadioStateRequest(callback: () => void): () => void {
+    this.stateRequestListeners.add(callback);
+    return () => {
+      this.stateRequestListeners.delete(callback);
+    };
+  }
+
+  public async openBoomBox(): Promise<{ success: boolean; tabId?: number; reused?: boolean; error?: string }> {
+    try {
+      const res: any = await this.sendExtensionMessage('OPEN_BOOMBOX', {}, 4000);
+      const isSuccess = Boolean(res?.success || res?.tabId || res?.reused !== undefined);
+      return { success: isSuccess, tabId: res?.tabId, reused: res?.reused };
+    } catch (err: any) {
+      return { success: false, error: err?.message || 'Failed to open Boom Box' };
+    }
+  }
+
+  public async broadcastRadioState(state: any): Promise<boolean> {
+    try {
+      const res = await this.sendExtensionMessage('BROADCAST_RADIO_STATE', state, 2000);
+      return !!res?.success;
+    } catch {
+      return false;
+    }
+  }
+
   public async connect(tabId?: number): Promise<{ success: boolean; status?: MusicPlaybackStatus; error?: string }> {
     try {
       const res = await this.sendExtensionMessage('CONNECT_YOUTUBE_TAB', { tabId });
```

#### `extension/background.js`
```diff
diff --git a/extension/background.js b/extension/background.js
index 455ec35..655f4f8 100644
--- a/extension/background.js
+++ b/extension/background.js
@@ -2,16 +2,79 @@
 // Reads version dynamically via chrome.runtime.getManifest().version
 
 let activeConnectedTabId = null;
+let activeRetroFmTabId = null;
+let activeBoomBoxTabId = null;
+let lastKnownRadioState = null;
+
+// Query for available Boom Box tabs
+async function resolveBoomBoxTab() {
+  if (activeBoomBoxTabId) {
+    try {
+      const tab = await chrome.tabs.get(activeBoomBoxTabId);
+      if (tab && tab.url && tab.url.includes('player/index.html')) {
+        return tab.id;
+      }
+    } catch (e) {
+      activeBoomBoxTabId = null;
+    }
+  }
+  try {
+    const tabs = await chrome.tabs.query({});
+    const found = tabs.find(t => t.url && t.url.includes('player/index.html'));
+    if (found) {
+      activeBoomBoxTabId = found.id;
+      return found.id;
+    }
+  } catch (e) {}
+  return null;
+}
+
+// Find best RetroFM web app tab (by tracked ID or localhost query)
+async function resolveRetroFmTab(requestedTabId) {
+  if (requestedTabId) {
+    try {
+      const tab = await chrome.tabs.get(requestedTabId);
+      if (tab) return tab.id;
+    } catch (e) {}
+  }
+  if (activeRetroFmTabId) {
+    try {
+      const tab = await chrome.tabs.get(activeRetroFmTabId);
+      if (tab) return tab.id;
+    } catch (e) {
+      activeRetroFmTabId = null;
+    }
+  }
+  try {
+    const tabs = await chrome.tabs.query({});
+    const matchingTabs = tabs.filter(t => t.url && (
+      t.url.includes('localhost') ||
+      t.url.includes('127.0.0.1') ||
+      t.url.includes('.run.app')
+    ));
+    if (matchingTabs.length > 0) {
+      const active = matchingTabs.find(t => t.active) || matchingTabs[0];
+      activeRetroFmTabId = active.id;
+      return active.id;
+    }
+  } catch (e) {}
+  return null;
+}
 
 // Query for available YouTube tabs
 async function listYouTubeTabs() {
-  const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
-  return tabs.map(tab => ({
-    id: tab.id,
-    title: tab.title,
-    url: tab.url,
-    active: tab.active
-  }));
+  try {
+    const tabs = await chrome.tabs.query({});
+    const ytTabs = tabs.filter(t => t.url && t.url.includes('youtube.com'));
+    return ytTabs.map(tab => ({
+      id: tab.id,
+      title: tab.title,
+      url: tab.url,
+      active: tab.active
+    }));
+  } catch (e) {
+    return [];
+  }
 }
 
 // Ensure the content_youtube script is injected into the target tab
@@ -112,6 +175,127 @@ function handleIncomingRequest(request, sender, sendResponse) {
         return;
       }
 
+      // Feature: OPEN_BOOMBOX - opens or focuses existing Boom Box player tab
+      if (type === 'OPEN_BOOMBOX') {
+        try {
+          const boomBoxUrl = chrome.runtime.getURL('player/index.html');
+          const existingTabId = await resolveBoomBoxTab();
+          let targetTab = null;
+          let reused = false;
+
+          if (existingTabId) {
+            targetTab = await chrome.tabs.get(existingTabId);
+            await chrome.tabs.update(existingTabId, { active: true });
+            if (targetTab.windowId) {
+              try {
+                await chrome.windows.update(targetTab.windowId, { focused: true });
+              } catch (e) {}
+            }
+            reused = true;
+          } else {
+            const createProps = { url: boomBoxUrl, active: true };
+            if (sender?.tab?.windowId) {
+              createProps.windowId = sender.tab.windowId;
+              if (typeof sender.tab.index === 'number') {
+                createProps.index = sender.tab.index + 1;
+              }
+            }
+            targetTab = await chrome.tabs.create(createProps);
+            activeBoomBoxTabId = targetTab.id;
+          }
+
+          sendResponse({
+            success: true,
+            data: { success: true, tabId: targetTab.id, reused }
+          });
+        } catch (openErr) {
+          sendResponse({ success: false, error: openErr.message });
+        }
+        return;
+      }
+
+      // Feature: BOOMBOX_ACTION - routes user command from Boom Box tab to RetroFM app
+      if (type === 'BOOMBOX_ACTION') {
+        try {
+          if (sender?.tab?.id) activeBoomBoxTabId = sender.tab.id;
+          const retroTabId = await resolveRetroFmTab();
+          if (!retroTabId) {
+            sendResponse({ success: false, error: 'RetroFM app tab not found' });
+            return;
+          }
+
+          const res = await chrome.tabs.sendMessage(retroTabId, {
+            type: 'BOOMBOX_ACTION',
+            payload
+          });
+          sendResponse({ success: true, data: res });
+        } catch (err) {
+          sendResponse({ success: false, error: err.message });
+        }
+        return;
+      }
+
+      // Feature: BROADCAST_RADIO_STATE - caches and relays live radio state from app to Boom Box
+      if (type === 'BROADCAST_RADIO_STATE') {
+        try {
+          if (sender?.tab?.id) activeRetroFmTabId = sender.tab.id;
+          lastKnownRadioState = { ...payload, appConnected: true, timestamp: Date.now() };
+
+          // Forward to Boom Box tab if open
+          const bbTabId = await resolveBoomBoxTab();
+          if (bbTabId) {
+            try {
+              await chrome.tabs.sendMessage(bbTabId, {
+                type: 'RADIO_STATE',
+                payload: lastKnownRadioState
+              });
+            } catch (sendErr) {
+              // Tab might be busy or navigating
+            }
+          }
+
+          sendResponse({ success: true });
+        } catch (err) {
+          sendResponse({ success: false, error: err.message });
+        }
+        return;
+      }
+
+      // Feature: GET_RADIO_STATE - Boom Box requests current state upon mount or reconnect
+      if (type === 'GET_RADIO_STATE') {
+        try {
+          if (sender?.tab?.id) activeBoomBoxTabId = sender.tab.id;
+          const retroTabId = await resolveRetroFmTab();
+          let freshState = null;
+
+          if (retroTabId) {
+            try {
+              await chrome.tabs.sendMessage(retroTabId, {
+                type: 'GET_RADIO_STATE_REQUEST'
+              });
+              if (lastKnownRadioState) {
+                lastKnownRadioState.appConnected = true;
+                freshState = lastKnownRadioState;
+              }
+            } catch (msgErr) {
+              activeRetroFmTabId = null;
+            }
+          }
+
+          if (!freshState && lastKnownRadioState) {
+            freshState = { ...lastKnownRadioState, appConnected: !!retroTabId };
+          }
+
+          sendResponse({
+            success: true,
+            data: freshState || { appConnected: false, playbackStatus: 'stopped' }
+          });
+        } catch (err) {
+          sendResponse({ success: false, error: err.message });
+        }
+        return;
+      }
+
       // Feature: LAUNCH_RETRO_FM - automatically open YouTube next to Retro FM, connect it, and group both tabs in "Retro FM"
       if (type === 'LAUNCH_RETRO_FM') {
         try {
@@ -443,3 +627,29 @@ if (chrome.runtime.onMessageExternal) {
 chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
   return handleIncomingRequest(request, sender, sendResponse);
 });
+
+// 3. Monitor tab closures for reliable connection recovery
+chrome.tabs.onRemoved.addListener(async (tabId) => {
+  if (tabId === activeConnectedTabId) {
+    activeConnectedTabId = null;
+  }
+  if (tabId === activeBoomBoxTabId) {
+    activeBoomBoxTabId = null;
+  }
+  if (tabId === activeRetroFmTabId) {
+    activeRetroFmTabId = null;
+    if (lastKnownRadioState) {
+      lastKnownRadioState.appConnected = false;
+      const bbTabId = await resolveBoomBoxTab();
+      if (bbTabId) {
+        try {
+          chrome.tabs.sendMessage(bbTabId, {
+            type: 'RADIO_STATE',
+            payload: { ...lastKnownRadioState, appConnected: false }
+          });
+        } catch (e) {}
+      }
+    }
+  }
+});
```

#### `extension/player/player.css`
```diff
diff --git a/extension/player/player.css b/extension/player/player.css
index 57f3b3f..d402fd0 100644
--- a/extension/player/player.css
+++ b/extension/player/player.css
@@ -6,28 +6,27 @@ body.dark{background:#000;--img:var(--imgB)}
 #panel{margin:6px 4% 0!important}
 #tgl{margin-left:6px;flex:none;align-self:center;width:26px;height:22px;padding:0;border:1px solid #4fbf7a;border-radius:4px;background:transparent;color:#8dffb0;font-size:13px;line-height:1;cursor:pointer}
 #panel.collapsed #chips,#panel.collapsed #status{display:none}
-#copy{flex:1;white-space:nowrap}
 #freq{display:flex;align-items:center;justify-content:flex-end;gap:7px;min-width:0}
-#sg{display:inline-block;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:opacity 1.5s ease}#sg.dim{opacity:.55}
+#sg{display:inline-block;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:opacity 1.2s ease-in-out}#sg.dim{opacity:.55}
+@media (prefers-reduced-motion: reduce){#sg{transition:none !important}}
 #sdot{flex:none;width:9px;height:9px;padding:0;border-radius:50%;border:1px solid #8dffb0;background:#8dffb0;cursor:pointer}#sdot[aria-pressed=false]{background:transparent}
-#panel.entry{background:#151311;color:#e9d9b8}
 #panel.entry #decades,#panel.entry #row,#panel.entry #chips,#panel.entry #status{display:none}
 #panel.live #board{display:none}
 #board{position:relative;cursor:text}
 #dIn{position:absolute;inset:0;width:100%;height:100%;opacity:0;font-size:16px;border:0}
-.bl{font-size:10px;letter-spacing:.14em;opacity:.55;margin:2px 0 3px;position:relative;z-index:2;cursor:pointer;width:max-content}.bl:hover{opacity:1}
+.bl{font-size:10px;letter-spacing:.14em;opacity:.7;color:#8dffb0;margin:2px 0 3px;position:relative;z-index:2;cursor:pointer;width:max-content}.bl:hover{opacity:1}
 #fDate,#fGen{white-space:nowrap;font-size:0;line-height:0}#fGen{position:relative;z-index:2;cursor:pointer}
-.fl{display:inline-block;vertical-align:top;width:17px;height:28px;margin:0 1px 0 0;background:#2a2622;border-radius:3px;color:#f2e8d0;font:700 15px/28px ui-monospace,Menlo,Consolas,monospace;text-align:center;position:relative;box-shadow:inset 0 -2px 0 rgba(0,0,0,.35)}
-.fl::after{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:rgba(0,0,0,.7)}
+.fl{display:inline-block;vertical-align:top;width:17px;height:28px;margin:0 1px 0 0;background:#0d2417;border:1px solid #1a422b;border-radius:3px;color:#a3ffc2;font:700 15px/26px ui-monospace,Menlo,Consolas,monospace;text-align:center;position:relative;box-shadow:inset 0 -2px 0 rgba(0,0,0,.45)}
+.fl::after{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:rgba(8,24,16,.85)}
 .fl.f{animation:flip .3s ease-in-out both}
 @keyframes flip{0%,100%{transform:rotateX(0)}50%{transform:rotateX(90deg)}}
-.ph .fl{color:#7b7266}
-#board[data-s=date] #bDate,#board[data-s=genre] #bGen{opacity:1;color:#ffb347;font-weight:700}
-.foc[data-s=date] #fDate .fl.cur{box-shadow:inset 0 0 0 1px #ffb347}
-#bHint{font-size:11px;margin-top:8px;opacity:.7}#bHint.err{color:#ff9a6b;opacity:1}
+.ph .fl{color:#2a6341}
+#board[data-s=date] #bDate,#board[data-s=genre] #bGen{opacity:1;color:#6ee7b7;font-weight:700}
+.foc[data-s=date] #fDate .fl.cur{box-shadow:inset 0 0 0 1px #6ee7b7;border-color:#34d399}
+#bHint{font-size:11px;margin-top:8px;opacity:.75;color:#8dffb0}#bHint.err{color:#ff9a6b;opacity:1}
 #decades{gap:6px;align-items:center}
-button.tag{background:transparent;color:#8dffb0;font:inherit;font-size:11px;cursor:pointer;transition:background .15s}button.tag:hover,button.tag:focus-visible{background:rgba(141,255,176,.2)}
-.tag{border:1px solid #4fbf7a;border-radius:4px;padding:3px 8px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%}
+button.tag{background:#0a1c12;color:#8dffb0;font:inherit;font-size:11px;cursor:pointer;transition:background .15s}button.tag:hover,button.tag:focus-visible{background:rgba(141,255,176,.25)}
+.tag{border:1px solid #235839;border-radius:4px;padding:3px 8px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%}
 #hUp{margin-left:auto;padding:3px 10px;border:1px solid #4fbf7a;border-radius:4px;background:#8dffb0;color:#0e2217;font:inherit;font-size:11px;cursor:pointer}
 #logoBar{order:3;height:62px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:6px 4% 0;border-top:1px solid rgba(128,128,128,.35);cursor:pointer}
 #fb{font-size:16px!important}#copy{font-size:11px;line-height:1.25;color:#777;text-align:right;cursor:default}body.dark #copy{color:#9a9a9a}#logo{max-height:50px;max-width:32%;width:auto;height:auto;object-fit:contain;display:block}#fb{font:700 22px Georgia,serif;letter-spacing:.08em;color:#222;display:none}body.dark #fb{color:#eee}
```

#### `extension/player/player.js`
```diff
diff --git a/extension/player/player.js b/extension/player/player.js
index b82cb37..4f4b23d 100644
--- a/extension/player/player.js
+++ b/extension/player/player.js
@@ -24,14 +24,16 @@ const ST={
 function setState(s,quiet){S.state=s;
  $('bPlay').classList.toggle('on',s==='playing');$('bPause').classList.toggle('on',s==='paused');
  $('gPlay').classList.toggle('on',s==='playing');document.querySelectorAll('.gp').forEach(e=>e.classList.toggle('on',s==='paused'));
- if(s==='stopped'){$('gStop').classList.add('on');setTimeout(()=>$('gStop').classList.remove('on'),700)}else $('gStop').classList.remove('on');
+ $('gStop').classList.remove('on');
  $('stage').classList.toggle('playing',s==='playing');
  $('st').textContent=s==='playing'?'\u25B6 PLAYING':s==='paused'?'\u275A\u275A PAUSED':'\u25A0 STOPPED';
+ if(s==='paused'||s==='stopped'||s==='playing'){renderSong();}
+ if(!vuRunning){vuRunning=true;requestAnimationFrame(vu);}
  if(!quiet)emit('transport',{state:s});}
 const act=(el,f)=>{el.onclick=f;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();f()}}};
-act($('bPlay'),()=>setState('playing'));
-act($('bPause'),()=>{if(S.state==='playing')setState('paused');else if(S.state==='paused')setState('playing')});
-act($('bStop'),()=>setState('stopped'));
+act($('bPlay'),()=>{sendBoomBoxAction('PLAY');});
+act($('bPause'),()=>{sendBoomBoxAction('PAUSE');});
+act($('bStop'),()=>{sendBoomBoxAction('STOP');});
 
 // knobs
 function knob(el,key,base,min,max,onSet,step){
@@ -45,19 +47,21 @@ function knob(el,key,base,min,max,onSet,step){
  el.onkeydown=e=>{const d={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1}[e.key];if(d){e.preventDefault();set(S[key]+d*step)}};
  rot();return set;
 }
-knob($('kVol'),'vol',-163,-140,140,()=>emit('volume',{value:S.vol}),.03);
-knob($('kBal'),'bal',10,-135,135,()=>emit('balance',{value:S.bal*2-1}),.04);
+knob($('kVol'),'vol',-163,-140,140,()=>{emit('volume',{value:S.vol});sendBoomBoxAction('SET_VOLUME',{volume:Math.round(S.vol*100)})},.03);
+knob($('kBal'),'bal',10,-135,135,()=>{const bVal=Number((S.bal*2-1).toFixed(2));emit('balance',{value:bVal});sendBoomBoxAction('SET_BALANCE',{balance:bVal})},.04);
 knob($('kTun'),'tun',40,-135,135,tune,.2/20.5);
-$('kBal').ondblclick=()=>{S.bal=.5;$('kBal').style.transform='rotate(-10deg)';emit('balance',{value:0})};
+$('kBal').ondblclick=()=>{S.bal=.5;$('kBal').style.transform='rotate(-10deg)';emit('balance',{value:0});sendBoomBoxAction('SET_BALANCE',{balance:0})};
 
 // optional deck buttons: rewind / fast forward flash when clicked, record latches on/off.
 // Set any of these to false to disable that button completely (no click area, no event).
 const BUTTONS={rewind:true,forward:true,record:true};
-[['rewind',573,'Previous song','gRew',true],['forward',625,'Next song','gFwd',true],['record',677,'Request a song','gRec',false]].forEach(([k,left,label,cls,pulse])=>{
+[['rewind',573,'Rewind 10s / Previous','gRew',true],['forward',625,'Fast forward 10s / Next','gFwd',true],['record',677,'Request a song','gRec',false]].forEach(([k,left,label,cls,pulse])=>{
  if(!BUTTONS[k])return;
  const b=document.createElement('div');b.className='hit btn';b.style.left=left+'px';b.tabIndex=0;b.setAttribute('role','button');b.setAttribute('aria-label',label);$('stage').appendChild(b);
  const gs=document.querySelectorAll('.'+cls);
- act(b,()=>{if(pulse){gs.forEach(e=>e.classList.add('on'));setTimeout(()=>gs.forEach(e=>e.classList.remove('on')),600);emit(k==='rewind'?'previous':'next',{})}
+ act(b,()=>{if(pulse){gs.forEach(e=>e.classList.add('on'));setTimeout(()=>gs.forEach(e=>e.classList.remove('on')),600);
+   if(k==='rewind'){sendBoomBoxAction('REWIND');emit('previous',{});}
+   else if(k==='forward'){sendBoomBoxAction('FAST_FORWARD');emit('next',{});}}
   else{const on=!gs[0].classList.contains('on');gs.forEach(e=>e.classList.toggle('on',on));emit('record',{on})}})});
 
 // display panel expand/collapse
@@ -98,7 +102,7 @@ function tune(){
  document.querySelectorAll('.chip').forEach(c=>c.classList.toggle('sel',!!best&&c.dataset.g===best[0]));
  const key=S.dec+'|'+(best?best[0]:'');
  if(best){$('hGen').textContent=best[0].toUpperCase();if(gl===ST[S.dec])gi=gl.indexOf(best)}
- if(key!==lastKey){lastKey=key;song=null;renderSong();marks();if(DEMO&&best&&pan.classList.contains('live')){const k=key;setTimeout(()=>{if(!song&&lastKey===k)setSong(demoFor(best[0]))},1200)}if(pan.classList.contains('live'))emit('tune',{decade:S.dec,frequency:f,genre:best?best[0]:null,locked:!!best})}
+ if(key!==lastKey){lastKey=key;if(!best){song=null;renderSong();}marks();if(pan.classList.contains('live')){emit('tune',{decade:S.dec,frequency:f,genre:best?best[0]:null,locked:!!best});sendBoomBoxAction('TUNE',{decade:S.dec,frequency:f,genre:best?best[0]:null,locked:!!best});}}
 }
 function setDec(d){S.dec=d;lastKey='';
  document.querySelectorAll('.dec').forEach(b=>b.classList.toggle('sel',+b.textContent===d));
@@ -113,20 +117,126 @@ const fx=f=>330+(f-87.5)*27.3;
  if(M)h+='<text x="'+x+'" y="153" text-anchor="middle" font-size="15" fill="#3d3a37" font-family="system-ui,sans-serif">'+f+'</text>'}
  $('scale').innerHTML=h})();
 function marks(){$('stn').innerHTML=ST[S.dec].map(s=>'<circle cx="'+fx(s[1]).toFixed(1)+'" cy="180" r="3.4" fill="#c8741a"/>').join('')}
-// placeholder song so the fade can be previewed; set DEMO=false once the app sends real songs
-const DEMO=true,DEMOS={'AOR':['Baker Street','Gerry Rafferty'],'Disco':['Le Freak','Chic'],'Grunge':['Smells Like Teen Spirit','Nirvana'],'Motown':['My Girl','The Temptations'],'New Wave':['Don\'t You Want Me','The Human League'],'Synth-Pop':['Tainted Love','Soft Cell']};
-const demoFor=g=>{const s=DEMOS[g]||['Sample Song Title','Sample Artist'];return{title:s[0],artist:s[1]}};
-// song info on the display: title and artist fade in turn (dot toggles); setSong({title,artist,year})
-let song=null,fadeOn=true,phase=0,sTimer=0;
-function renderSong(){const el=$('sg');clearInterval(sTimer);el.className='';el.style.opacity=1;el.title='';
- if(!fadeOn){el.textContent='';return}
- if(!S.locked){el.textContent='\u2591 static \u2591';return}
- if(!song){el.textContent='Finding a song\u2026';el.className='dim';return}
- el.title=song.title+(song.artist?' by '+song.artist:'');
- if(!song.artist){el.textContent=song.title;return}
- el.textContent=song.title;phase=1;el.style.opacity=0;requestAnimationFrame(()=>requestAnimationFrame(()=>{el.style.opacity=1}));sTimer=setInterval(showSong,9000)}
-function showSong(){const el=$('sg');if(!song)return;el.style.opacity=0;setTimeout(()=>{if(!song)return;el.textContent=phase?song.artist:song.title;el.style.opacity=1;phase^=1},1500)}
-function setSong(d){song=d&&d.title?{title:String(d.title),artist:String(d.artist||'')}:null;renderSong()}
+// Live mode: real songs received from RetroFM session
+const DEMO=false;
+// song info on the display: title and artist alternate with 1.2s fade and 3s hold
+let song=null,fadeOn=true,phase=0,sTimer=0,sFadeTimer=0,appConnected=false;
+
+function clearSongTimers(){
+  if(sTimer){clearTimeout(sTimer);sTimer=0;}
+  if(sFadeTimer){clearTimeout(sFadeTimer);sFadeTimer=0;}
+}
+
+function renderSong(){
+  const el=$('sg');
+  clearSongTimers();
+  el.className='';
+  el.style.opacity='1';
+  el.title='';
+
+  if(!fadeOn){el.textContent='';return;}
+  if(!appConnected){el.textContent='Offline';el.className='dim';return;}
+  if(!S.locked){el.textContent='\u2591 static \u2591';return;}
+
+  if(!song){
+    el.textContent='No song selected';
+    el.className='dim';
+    return;
+  }
+
+  el.title=song.title+(song.artist?' by '+song.artist:'');
+  if(!song.artist){
+    el.textContent=song.title;
+    return;
+  }
+
+  // Two screens: phase 0 = Song Title, phase 1 = Artist
+  phase=0;
+  el.textContent=song.title;
+  if(S.state==='playing'){
+    scheduleSongFade();
+  }
+}
+
+function scheduleSongFade(){
+  clearSongTimers();
+  if(!song||!song.artist||!fadeOn||!appConnected||!S.locked||S.state!=='playing')return;
+
+  // Hold current screen for 3000ms
+  sTimer=setTimeout(()=>{
+    const el=$('sg');
+    if(!el)return;
+    // Fade out (CSS transition: 1.2s)
+    el.style.opacity='0';
+    sFadeTimer=setTimeout(()=>{
+      if(!song||!fadeOn||!appConnected||!S.locked||S.state!=='playing')return;
+      // Switch screen: phase 0 was Title -> next is Artist (1); phase 1 was Artist -> next is Title (0)
+      phase=phase===0?1:0;
+      el.textContent=phase===1?song.artist:song.title;
+      // Fade in
+      el.style.opacity='1';
+      // Schedule next rotation
+      scheduleSongFade();
+    },1200);
+  },3000);
+}
+
+function cleanTitle(rawTitle, artist) {
+  if (!rawTitle) return '';
+  let t = String(rawTitle).trim();
+  // Strip release year in parentheses e.g. (1985) or (1985 Remastered)
+  t = t.replace(/\s*\(\s*(?:19\d{2}|20\d{2})\s*(?:remaster(?:ed)?|mix|edit|version)?\s*\)/gi, '');
+  // Also strip [1985] or [1985 Remastered]
+  t = t.replace(/\s*\[\s*(?:19\d{2}|20\d{2})\s*(?:remaster(?:ed)?|mix|edit|version)?\s*\]/gi, '');
+
+  // Strip leading artist if present at start e.g. "a-ha - Take on Me" or "a-ha — Take on Me"
+  if (artist && artist.trim()) {
+    const aEsc = artist.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
+    const leadArtistRegex = new RegExp('^' + aEsc + '\\s*[-:—–~]\\s*', 'i');
+    t = t.replace(leadArtistRegex, '');
+  } else {
+    // If no artist provided, check if format is "Artist - Title" (allowing hyphens inside artist name by splitting on first space-dash-space or em-dash)
+    const match = t.match(/^(.*?)\s+(?:[-—–~]|:)\s+(.*)$/);
+    if (match) {
+      t = match[2];
+    }
+  }
+  return t.trim();
+}
+
+function cleanArtist(rawArtist, rawTitle) {
+  if (rawArtist && String(rawArtist).trim() && String(rawArtist).trim() !== 'undefined' && String(rawArtist).trim() !== 'null') {
+    return String(rawArtist).trim();
+  }
+  // Fallback: extract leading artist from combined title e.g. "a-ha - Take on Me (1985)" or "a-ha — Take on Me"
+  if (rawTitle) {
+    const match = String(rawTitle).trim().match(/^(.*?)\s+(?:[-—–~]|:)\s+(.*)$/);
+    if (match && match[1].trim()) {
+      return match[1].trim();
+    }
+  }
+  return '';
+}
+
+function setSong(d){
+  if(d&&d.title){
+    const rawTitle=String(d.title).trim();
+    const rawArtist=d.artist?String(d.artist).trim():'';
+    if(rawTitle&&rawTitle!=='undefined'&&rawTitle!=='null'){
+      const artist = cleanArtist(rawArtist, rawTitle);
+      const title = cleanTitle(rawTitle, artist);
+      song={title: title || rawTitle, artist};
+    }else{
+      song=null;
+    }
+  }else{
+    song=null;
+  }
+  renderSong();
+}
+window.addEventListener('beforeunload',()=>{clearSongTimers();});
 $('sdot').onclick=()=>{fadeOn=!fadeOn;$('sdot').setAttribute('aria-pressed',fadeOn);$('sdot').title=fadeOn?'Hide song info':'Show song info';renderSong()};
 
 // entry board: type a date, pick a genre, press Enter to tune in
@@ -170,7 +280,9 @@ function goLive(){const y=D.getFullYear(),dec=Math.floor(y/10)*10,g=gl[gi];
  pan.classList.replace('entry','live');
  $('hDate').textContent=MON[D.getMonth()]+' '+D.getDate()+', '+y;$('hGen').textContent=g[0].toUpperCase();
  S.tun=(g[1]-MIN)/SPAN;setDec(dec);
- emit('select',{date:y+'-'+String(D.getMonth()+1).padStart(2,'0')+'-'+String(D.getDate()).padStart(2,'0'),year:y,decade:dec,genre:g[0],frequency:g[1]})}
+ const dateStr=y+'-'+String(D.getMonth()+1).padStart(2,'0')+'-'+String(D.getDate()).padStart(2,'0');
+ emit('select',{date:dateStr,year:y,decade:dec,genre:g[0],frequency:g[1]});
+ sendBoomBoxAction('SELECT_DATE_GENRE',{date:dateStr,year:y,decade:dec,genre:g[0],frequency:g[1]});}
 dIn.oninput=e=>{step='date';let v=dIn.value.replace(/[^A-Za-z0-9 ,\/\-]/g,'').replace(/^\s+/,'').replace(/\s{2,}/g,' ').replace(/,\s*,/g,', ');
  if(e.inputType&&e.inputType.startsWith('insert')){
   v=v.replace(/^([A-Za-z]+)(?=\d)/,'$1 ');
@@ -197,16 +309,169 @@ const back=s=>{pan.classList.replace('live','entry');step=s;emit('update',{});re
 $('hDate').onclick=()=>back('date');$('hGen').onclick=()=>back('genre');
 tune();refresh();dIn.focus();
 
-// VU meters (simulated: the music plays in the YouTube tab, so no audio to analyse)
-let env=0,nl=0,nr=0,beat=.5;
+// VU meters (simulated: music plays in YouTube tab; needles scale directly with master volume)
+let env=0,nl=0,nr=0,beat=.5,vuRunning=false;
 function vu(){
- if(S.state==='playing'){if(Math.random()<.14)beat=.35+Math.random()*.55;env+=(beat-env)*.3}else env*=.9;
- const v=.55+.45*S.vol,gl=S.bal<=.5?1:2*(1-S.bal),gr=S.bal>=.5?1:2*S.bal;
- const tl=S.state==='playing'?env*gl*v*(.92+Math.random()*.16):0,tr=S.state==='playing'?env*gr*v*(.92+Math.random()*.16):0;
- nl+=(tl-nl)*(tl>nl?.35:.1);nr+=(tr-nr)*(tr>nr?.35:.1);
- aim('nl',833,nl);aim('nr',957,nr);requestAnimationFrame(vu);
+ const isPlaying = S.state === 'playing';
+ if(isPlaying){
+  if(Math.random()<.14) beat=.35+Math.random()*.55;
+  env += (beat-env)*.3;
+ } else {
+  env *= .85;
+ }
+
+ // Master volume scaling: at vol=0, needles stay completely at rest
+ const v = Math.max(0, S.vol);
+ const gl = S.bal<=.5 ? 1 : 2*(1-S.bal);
+ const gr = S.bal>=.5 ? 1 : 2*S.bal;
+
+ const tl = isPlaying ? env * gl * v * (.88 + Math.random()*.24) : 0;
+ const tr = isPlaying ? env * gr * v * (.88 + Math.random()*.24) : 0;
+
+ nl += (tl-nl) * (tl > nl ? .35 : .12);
+ nr += (tr-nr) * (tr > nr ? .35 : .12);
+
+ aim('nl', 833, nl);
+ aim('nr', 957, nr);
+
+ // Stop RAF loop once needles have settled back to zero if not playing
+ if(isPlaying || nl > 0.005 || nr > 0.005 || env > 0.005){
+  vuRunning = true;
+  requestAnimationFrame(vu);
+ } else {
+  nl = 0; nr = 0; env = 0;
+  aim('nl', 833, 0);
+  aim('nr', 957, 0);
+  vuRunning = false;
+ }
 }
 function aim(id,px,l){const a=(-47+clamp(l)*94)*Math.PI/180,n=$(id);n.setAttribute('x2',px+Math.sin(a)*58);n.setAttribute('y2',352-Math.cos(a)*58)}
-vu();
+vuRunning = true;
+requestAnimationFrame(vu);
 
 $('copy').onclick=e=>e.stopPropagation();
+
+// --- Chrome Extension Integration Bridge ---
+function setVisualVolume(fraction) {
+  if (typeof fraction !== 'number' || isNaN(fraction)) return;
+  S.vol = clamp(fraction);
+  $('kVol').style.transform = 'rotate(' + (-140 + S.vol * 280 - (-163)) + 'deg)';
+}
+
+function setVisualTransport(state) {
+  if (state === 'playing' || state === 'paused' || state === 'stopped') {
+    setState(state, true);
+  }
+}
+
+function sendBoomBoxAction(action, data) {
+  try {
+    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
+      chrome.runtime.sendMessage({
+        type: 'BOOMBOX_ACTION',
+        payload: { action, ...(data || {}) }
+      }, () => {
+        if (chrome.runtime?.lastError) {
+          // Extension service worker might be waking up or app disconnected
+        }
+      });
+    }
+  } catch (err) {
+    console.warn('[BoomBox] Action send error:', err);
+  }
+}
+
+function applyRadioState(state) {
+  if (!state || typeof state !== 'object') return;
+  appConnected = state.appConnected !== false;
+
+  if (!appConnected) {
+    $('st').textContent = '■ DISCONNECTED';
+    $('gi').textContent = 'Open RetroFM app to broadcast';
+    song = null;
+    renderSong();
+    return;
+  }
+
+  // 1. Playback status
+  if (state.playbackStatus) {
+    setVisualTransport(state.playbackStatus);
+  }
+
+  // 2. Volume (visual only, no command feedback loop)
+  if (typeof state.masterVolume === 'number') {
+    setVisualVolume(state.masterVolume / 100);
+  }
+
+  // 3. Current Song
+  if (state.currentSong && state.currentSong.title) {
+    setSong(state.currentSong);
+    if (state.currentSong.year) {
+      const y = Number(state.currentSong.year);
+      if (!isNaN(y)) setSongYear(y);
+    }
+  } else if (state.clearSong) {
+    song = null;
+    renderSong();
+  } else if (!song) {
+    renderSong();
+  }
+
+  // 4. Frequency & Station
+  if (typeof state.frequency === 'number' && state.decade) {
+    if (S.dec !== state.decade && ST[state.decade]) {
+      setDec(state.decade);
+    }
+    const targetTun = (state.frequency - MIN) / SPAN;
+    if (Math.abs(S.tun - targetTun) > 0.01) {
+      S.tun = clamp(targetTun);
+      tune();
+    }
+  }
+
+  // 5. Date
+  if (state.date) {
+    const parsed = parseDate(state.date);
+    if (parsed) {
+      D = parsed;
+      $('hDate').textContent = MON[D.getMonth()] + ' ' + D.getDate() + ', ' + D.getFullYear();
+    }
+  }
+}
+
+function requestRadioState() {
+  try {
+    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
+      chrome.runtime.sendMessage({ type: 'GET_RADIO_STATE' }, (response) => {
+        if (!chrome.runtime?.lastError && response?.success && response?.data) {
+          applyRadioState(response.data);
+        } else {
+          appConnected = false;
+          $('st').textContent = '■ DISCONNECTED';
+          $('gi').textContent = 'Open RetroFM app to broadcast';
+          renderSong();
+        }
+      });
+    }
+  } catch (e) {}
+}
+
+if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
+  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
+    if (message && message.type === 'RADIO_STATE') {
+      applyRadioState(message.payload);
+      sendResponse({ received: true });
+    }
+    return true;
+  });
+}
+
+// Request initial state on load
+requestRadioState();
+// Check health every 6 seconds if disconnected
+setInterval(() => {
+  if (!appConnected) {
+    requestRadioState();
+  }
+}, 6000);
```

#### `src/App.tsx`
```diff
diff --git a/src/App.tsx b/src/App.tsx
index d22ae05..5a8750b 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -3,7 +3,7 @@
  * SPDX-License-Identifier: MIT
  */
 
-import React, { useState, useEffect, useRef } from 'react';
+import React, { useState, useEffect, useRef, useCallback } from 'react';
 import {
   Radio,
   Play,
@@ -160,6 +160,8 @@ export default function App() {
   const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
   const [isConnecting, setIsConnecting] = useState<boolean>(false);
   const [isLaunchingGroup, setIsLaunchingGroup] = useState<boolean>(false);
+  const [isOpeningBoomBox, setIsOpeningBoomBox] = useState<boolean>(false);
+  const hasAutoOpenedBoomBoxRef = useRef<boolean>(false);
   const [launchMessage, setLaunchMessage] = useState<{ text: string; isError: boolean } | null>(null);
   const [connectionError, setConnectionError] = useState<string | null>(null);
 
@@ -468,6 +470,12 @@ export default function App() {
         } catch (e) {
           // Tabs query might require permissions or extension reload
         }
+
+        // Auto-open or focus Boom Box player tab on initial load
+        if (!hasAutoOpenedBoomBoxRef.current) {
+          hasAutoOpenedBoomBoxRef.current = true;
+          musicProviderRef.current.openBoomBox().catch(() => {});
+        }
       }
     };
 
@@ -476,6 +484,163 @@ export default function App() {
     return () => clearInterval(interval);
   }, []);
 
+  // --- Open Boom Box Player Tab Handler ---
+  const handleOpenBoomBox = async () => {
+    setIsOpeningBoomBox(true);
+    logMessage('Opening or focusing Boom Box player tab...');
+    try {
+      const res = await musicProviderRef.current.openBoomBox();
+      if (res.success) {
+        logMessage(`✓ Boom Box player tab ${res.reused ? 'focused' : 'opened'}.`);
+        broadcastCurrentRadioState();
+      } else {
+        const errDetail = res.error || 'Extension did not respond or Boom Box tab failed to open. Ensure RetroFM Extension is reloaded in chrome://extensions.';
+        console.warn('[RetroFM] Failed to open Boom Box tab:', res);
+        logMessage(`[Boom Box Warning] ${errDetail}`);
+      }
+    } catch (err: any) {
+      console.error('[RetroFM] Boom Box launch error:', err);
+      logMessage(`[Boom Box Error] ${err.message || 'Failed to open Boom Box'}`);
+    } finally {
+      setIsOpeningBoomBox(false);
+    }
+  };
+
+  // Track transport command timestamps to avoid poller overwriting immediate user actions
+  const lastTransportCommandTimeRef = useRef<number>(0);
+
+  // --- Broadcast Current Radio State to Boom Box ---
+  const broadcastCurrentRadioState = useCallback(() => {
+    const vc = volumeControllerRef.current;
+    const currentVol = vc ? vc.getUserVolume() : targetMusicVolume;
+    const isDuck = vc ? vc.getState() !== 'idle' : isDuckingActive;
+
+    // Preserve valid song metadata across playing, paused, and stopped states
+    let currentSong = null;
+    if (programSongResult && programSongResult.selectedTitle) {
+      currentSong = {
+        title: programSongResult.selectedTitle,
+        artist: programArtist || '',
+        year: programYear || '',
+        duration: programSongResult.selectedDuration
+      };
+    } else if (playbackStatus && playbackStatus.title && playbackStatus.title !== 'Unknown Title' && playbackStatus.title !== 'Unknown Video') {
+      currentSong = {
+        title: playbackStatus.title,
+        artist: programArtist || '',
+        year: programYear || ''
+      };
+    } else if (programSongTitle) {
+      currentSong = {
+        title: programSongTitle,
+        artist: programArtist || '',
+        year: programYear || ''
+      };
+    }
+
+    const yearNum = parseInt(programYear, 10);
+    const decade = (!isNaN(yearNum) && yearNum >= 1960 && yearNum <= 2029)
+      ? Math.floor(yearNum / 10) * 10
+      : 1980;
+
+    // Default primary stations per decade from Boom Box ST table
+    const DECADE_STATIONS: Record<number, { freq: number; genre: string }> = {
+      1960: { freq: 95.1, genre: 'Top 40/Pop' },
+      1970: { freq: 95.5, genre: 'AOR' },
+      1980: { freq: 101.9, genre: 'CHR' },
+      1990: { freq: 100.3, genre: 'Teen Pop' },
+      2000: { freq: 102.3, genre: 'Electropop' },
+      2010: { freq: 101.1, genre: 'EDM' },
+      2020: { freq: 90.9, genre: 'Hyperpop' }
+    };
+
+    const station = DECADE_STATIONS[decade] || { freq: 101.9, genre: 'CHR' };
+
+    const statePayload = {
+      playbackStatus: playbackStatus.isPlaying ? 'playing' : (playbackStatus.available && playbackStatus.currentTime > 0 ? 'paused' : 'stopped'),
+      currentSong,
+      date: programYear ? `${programYear}-07-04` : '1985-07-13',
+      decade,
+      frequency: station.freq,
+      genre: station.genre,
+      masterVolume: currentVol,
+      duckLevel: vc ? vc.getDuckLevel() : duckVolumePercent,
+      isDucking: isDuck,
+      appConnected: true,
+      timestamp: Date.now()
+    };
+
+    musicProviderRef.current.broadcastRadioState(statePayload).catch(() => {});
+  }, [playbackStatus, programSongResult, programArtist, programSongTitle, programYear, targetMusicVolume, isDuckingActive, duckVolumePercent]);
+
+  // Refs for action handlers to prevent stale closures in the Boom Box subscription
+  const handlePlayMusicRef = useRef<() => Promise<void>>(async () => {});
+  const handlePauseMusicRef = useRef<() => Promise<void>>(async () => {});
+  const handleStopMusicRef = useRef<() => Promise<void>>(async () => {});
+  const handleRewindMusicRef = useRef<() => Promise<void>>(async () => {});
+  const handleFastForwardMusicRef = useRef<() => Promise<void>>(async () => {});
+
+  // Synchronize state to Boom Box whenever session properties change
+  useEffect(() => {
+    broadcastCurrentRadioState();
+  }, [broadcastCurrentRadioState]);
+
+  // Listen for actions and state requests from Boom Box
+  useEffect(() => {
+    const unsubAction = musicProviderRef.current.onBoomBoxAction(async (action: any) => {
+      if (!action || !action.action) return;
+      logMessage(`[Boom Box Action] ${action.action}`);
+      switch (action.action) {
+        case 'PLAY':
+          await handlePlayMusicRef.current();
+          break;
+        case 'PAUSE':
+          await handlePauseMusicRef.current();
+          break;
+        case 'STOP':
+          await handleStopMusicRef.current();
+          break;
+        case 'REWIND':
+        case 'PREVIOUS':
+          await handleRewindMusicRef.current();
+          break;
+        case 'FAST_FORWARD':
+        case 'NEXT':
+          await handleFastForwardMusicRef.current();
+          break;
+        case 'SET_VOLUME':
+          if (typeof action.volume === 'number' && volumeControllerRef.current) {
+            await volumeControllerRef.current.setUserVolume(action.volume, 'Boom Box Knob');
+          }
+          break;
+        case 'SET_BALANCE':
+          if (typeof action.balance === 'number') {
+            logMessage(`[Boom Box Balance] Stereo balance set to ${action.balance.toFixed(2)} (Pan: ${Math.round(action.balance * 100)}%)`);
+          }
+          break;
+        case 'TUNE':
+          if (action.genre) {
+            logMessage(`[Boom Box Dial] Tuned: ${action.frequency} FM (${action.genre})`);
+          }
+          break;
+        case 'SELECT_DATE_GENRE':
+          if (action.date) {
+            logMessage(`[Boom Box Date] Date: ${action.date} | Station: ${action.genre || 'N/A'}`);
+          }
+          break;
+      }
+    });
+
+    const unsubReq = musicProviderRef.current.onRadioStateRequest(() => {
+      broadcastCurrentRadioState();
+    });
+
+    return () => {
+      unsubAction();
+      unsubReq();
+    };
+  }, [broadcastCurrentRadioState]);
+
   // --- Poll YouTube Tab Status ---
   useEffect(() => {
     if (!playbackStatus.connectedTabId) return;
@@ -483,7 +648,20 @@ export default function App() {
     const poll = async () => {
       try {
         const s = await musicProviderRef.current.getStatus();
-        setPlaybackStatus(s);
+        // If a transport command was executed within the last 2.5 seconds,
+        // do not let a transitional or lagging poll result overwrite the user's explicit action
+        const timeSinceCmd = Date.now() - lastTransportCommandTimeRef.current;
+        if (timeSinceCmd > 2500) {
+          setPlaybackStatus(s);
+        } else {
+          // Merge non-transport properties (volume, title, url) while preserving recent transport state
+          setPlaybackStatus((prev) => ({
+            ...s,
+            isPlaying: prev.isPlaying,
+            currentTime: prev.currentTime === 0 && !prev.isPlaying ? 0 : s.currentTime
+          }));
+        }
+
         if (s.available) {
           setTestResults((prev) => ({
             ...prev,
@@ -587,41 +765,123 @@ export default function App() {
 
   // --- Playback Controls ---
   const handlePlayMusic = async () => {
+    lastTransportCommandTimeRef.current = Date.now();
     logMessage('Sending Play command to YouTube tab...');
+    // If not connected to a YouTube tab yet, launch RetroFM tab group or program the current song preset
+    if (!playbackStatus.connectedTabId) {
+      logMessage('No active YouTube tab connected. Launching tab group / programming selected song...');
+      const groupRes = await musicProviderRef.current.launchRetroFmGroup();
+      if (groupRes?.connectedTabId) {
+        if (groupRes.status) setPlaybackStatus(groupRes.status);
+      }
+      await handleProgramSong();
+      broadcastCurrentRadioState();
+      return;
+    }
+
+    // If currently stopped at position 0, seek to 0 and start playback
+    if (!playbackStatus.isPlaying && playbackStatus.currentTime === 0) {
+      await musicProviderRef.current.seek(0).catch(() => {});
+    }
+
     const ok = await musicProviderRef.current.play();
     if (ok) {
       if (volumeControllerRef.current) {
         await volumeControllerRef.current.syncInitialVolume('Play button pressed');
       }
       logMessage('▶ Playback started on YouTube tab.');
+      setPlaybackStatus((prev) => ({ ...prev, isPlaying: true }));
       setTestResults((prev) => ({ ...prev, playbackControl: true }));
+      broadcastCurrentRadioState();
     } else {
-      logMessage('Failed to trigger Play on YouTube tab. Make sure a YouTube video is open in another tab.');
+      logMessage('Play command failed or tab was idle. Attempting to program selected song...');
+      await handleProgramSong();
+      broadcastCurrentRadioState();
     }
   };
 
   const handlePauseMusic = async () => {
+    lastTransportCommandTimeRef.current = Date.now();
     logMessage('Sending Pause command to YouTube tab...');
+    // Synchronously update local playback status to paused immediately
+    setPlaybackStatus((prev) => ({ ...prev, isPlaying: false, currentTime: prev.currentTime > 0 ? prev.currentTime : 1 }));
+    broadcastCurrentRadioState();
+
     const ok = await musicProviderRef.current.pause();
     if (ok) {
       logMessage('⏸ Playback paused on YouTube tab.');
       setTestResults((prev) => ({ ...prev, playbackControl: true }));
     } else {
-      logMessage('Failed to trigger Pause on YouTube tab.');
+      logMessage('Notice: Pause command sent to YouTube tab.');
     }
+    broadcastCurrentRadioState();
   };
 
   const handleStopMusic = async () => {
+    lastTransportCommandTimeRef.current = Date.now();
     logMessage('Sending Stop command to YouTube tab...');
+    // Synchronously set local and broadcast state to stopped at position 0 immediately
+    setPlaybackStatus((prev) => ({ ...prev, isPlaying: false, currentTime: 0 }));
+    broadcastCurrentRadioState();
+
     const ok = await musicProviderRef.current.stop();
     if (ok) {
       logMessage('⏹ Playback stopped on YouTube tab.');
       setTestResults((prev) => ({ ...prev, playbackControl: true }));
     } else {
-      logMessage('Failed to trigger Stop on YouTube tab.');
+      logMessage('Stop command sent (transport reset to stopped).');
+    }
+    broadcastCurrentRadioState();
+  };
+
+  const handleRewindMusic = async () => {
+    logMessage('Seeking backward 10s on YouTube tab...');
+    try {
+      const currentStatus = await musicProviderRef.current.getStatus();
+      const newPos = Math.max(0, (currentStatus?.currentTime || 0) - 10);
+      const ok = await musicProviderRef.current.seek(newPos);
+      if (ok) {
+        setPlaybackStatus((prev) => ({ ...prev, currentTime: newPos }));
+        logMessage(`⏪ Rewound to ${Math.round(newPos)}s.`);
+        broadcastCurrentRadioState();
+      } else {
+        logMessage('Failed to rewind on YouTube tab.');
+      }
+    } catch (e: any) {
+      logMessage(`Rewind error: ${e.message}`);
+    }
+  };
+
+  const handleFastForwardMusic = async () => {
+    logMessage('Seeking forward 10s on YouTube tab...');
+    try {
+      const currentStatus = await musicProviderRef.current.getStatus();
+      const currentPos = currentStatus?.currentTime || 0;
+      const duration = currentStatus?.duration || (currentPos + 30);
+      const newPos = Math.min(duration, currentPos + 10);
+      const ok = await musicProviderRef.current.seek(newPos);
+      if (ok) {
+        setPlaybackStatus((prev) => ({ ...prev, currentTime: newPos }));
+        logMessage(`⏩ Fast forwarded to ${Math.round(newPos)}s.`);
+        broadcastCurrentRadioState();
+      } else {
+        logMessage('Failed to fast forward on YouTube tab.');
+      }
+    } catch (e: any) {
+      logMessage(`Fast forward error: ${e.message}`);
     }
   };
 
+  handlePlayMusicRef.current = handlePlayMusic;
+  handlePauseMusicRef.current = handlePauseMusic;
+  handleStopMusicRef.current = handleStopMusic;
+  handleRewindMusicRef.current = handleRewindMusic;
+  handleFastForwardMusicRef.current = handleFastForwardMusic;
+
   // --- PROGRAM SONG Handler ---
   const handleProgramSong = async (customOverride?: { artist: string; song: string; year: string }) => {
     const artist = (customOverride ? customOverride.artist : programArtist).trim();
@@ -1509,6 +1765,17 @@ export default function App() {
               <span>SILENCE ALL AUDIO</span>
             </button>
 
+            {/* Open Boom Box Player Tab */}
+            <button
+              onClick={handleOpenBoomBox}
+              disabled={isOpeningBoomBox}
+              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-mono font-black text-xs uppercase tracking-wider transition-colors shadow cursor-pointer"
+              title="Open or focus the standalone Boom Box radio player tab"
+            >
+              <Radio className={`w-3.5 h-3.5 ${isOpeningBoomBox ? 'animate-pulse' : ''}`} />
+              <span>{isOpeningBoomBox ? 'Opening...' : 'Open Boom Box'}</span>
+            </button>
+
             {/* Launch RetroFM (Chrome Tab Group) Button */}
```

---

## 2. Trace the Actual Play Command

The Play command begins at the Boom Box user interface in `player/index.html` and terminates in the YouTube player tab.

### Step 1: The Play Button Element & Event Listener
**File**: [`extension/player/index.html`](file:///Users/chris/Projects/RetroFM/extension/player/index.html#L15-L20)
```html
15:   <polygon id="gPlay" class="lit" points="433.2,555.2 433,563.8 448.2,559.4"/>
...
20:  <div class="hit btn" id="bPlay" role="button" aria-label="Play" tabindex="0" style="left:412px"></div>
```
- `#bPlay` is an interactive `<div>` element positioned over the boom box faceplate at `left: 412px; top: 544px; width: 54px; height: 54px`.
- `#gPlay` is the corresponding SVG polygon indicator that illuminates when active.

**File**: [`extension/player/player.js`](file:///Users/chris/Projects/RetroFM/extension/player/player.js#L33-L34)
```javascript
33: const act=(el,f)=>{el.onclick=f;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();f()}}};
34: act($('bPlay'),()=>{sendBoomBoxAction('PLAY');});
```

### Step 2: The Function Called When Clicking Play
When the user clicks `#bPlay` or presses Enter/Space:
```javascript
() => { sendBoomBoxAction('PLAY'); }
```
It does not immediately invoke `setState('playing')`. It delegates solely to `sendBoomBoxAction('PLAY')`.

### Step 3: Message Sent from Boom Box to Background Worker
**File**: [`extension/player/player.js`](file:///Users/chris/Projects/RetroFM/extension/player/player.js#L368-L384)
```javascript
368: function sendBoomBoxAction(action, data) {
369:   try {
370:     if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
371:       chrome.runtime.sendMessage({
372:         type: 'BOOMBOX_ACTION',
373:         payload: { action, ...(data || {}) }
374:       }, () => {
375:         if (chrome.runtime?.lastError) {
376:           // Extension service worker might be waking up or app disconnected
377:         }
378:       });
379:     }
380:   } catch (err) {
381:     console.warn('[BoomBox] Action send error:', err);
382:   }
383: }
```
The message payload is `{ type: 'BOOMBOX_ACTION', payload: { action: 'PLAY' } }`.

### Step 4: Background Service Worker Message-Routing Logic
**File**: [`extension/background.js`](file:///Users/chris/Projects/RetroFM/extension/background.js#L216-L235)
```javascript
216:       // Feature: BOOMBOX_ACTION - routes user command from Boom Box tab to RetroFM app
217:       if (type === 'BOOMBOX_ACTION') {
218:         try {
219:           if (sender?.tab?.id) activeBoomBoxTabId = sender.tab.id;
220:           const retroTabId = await resolveRetroFmTab();
221:           if (!retroTabId) {
222:             sendResponse({ success: false, error: 'RetroFM app tab not found' });
223:             return;
224:           }
225: 
226:           const res = await chrome.tabs.sendMessage(retroTabId, {
227:             type: 'BOOMBOX_ACTION',
228:             payload
229:           });
230:           sendResponse({ success: true, data: res });
231:         } catch (err) {
232:           sendResponse({ success: false, error: err.message });
233:         }
234:         return;
235:       }
```

### Step 5: Code Selecting Destination RetroFM App Tab
**File**: [`extension/background.js`](file:///Users/chris/Projects/RetroFM/extension/background.js#L32-L61)
```javascript
32: // Find best RetroFM web app tab (by tracked ID or localhost query)
33: async function resolveRetroFmTab(requestedTabId) {
34:   if (requestedTabId) {
35:     try {
36:       const tab = await chrome.tabs.get(requestedTabId);
37:       if (tab) return tab.id;
38:     } catch (e) {}
39:   }
40:   if (activeRetroFmTabId) {
41:     try {
42:       const tab = await chrome.tabs.get(activeRetroFmTabId);
43:       if (tab) return tab.id;
44:     } catch (e) {
45:       activeRetroFmTabId = null;
46:     }
47:   }
48:   try {
49:     const tabs = await chrome.tabs.query({});
50:     const matchingTabs = tabs.filter(t => t.url && (
51:       t.url.includes('localhost') ||
52:       t.url.includes('127.0.0.1') ||
53:       t.url.includes('.run.app')
54:     ));
55:     if (matchingTabs.length > 0) {
56:       const active = matchingTabs.find(t => t.active) || matchingTabs[0];
57:       activeRetroFmTabId = active.id;
58:       return active.id;
59:     }
60:   } catch (e) {}
61:   return null;
62: }
```

### Step 6: App Receiver & Dispatch Logic
In the RetroFM web app tab, `content_retrofm.js` relays the message from Chrome extension IPC to the webpage `window.postMessage`:
**File**: [`extension/content_retrofm.js`](file:///Users/chris/Projects/RetroFM/extension/content_retrofm.js#L153-L169)
```javascript
153:     chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
...
158:       if (message && typeof message === 'object') {
159:         const payload = {
160:           source: SOURCE_EXT,
161:           ...message
162:         };
163:         try {
164:           window.postMessage(payload, '*');
165:         } catch (e) {}
166:       }
167:       sendResponse({ received: true });
168:       return true;
169:     });
```

In `YouTubeMusicProvider.ts`, the postMessage listener fires the subscription:
**File**: [`src/services/music/YouTubeMusicProvider.ts`](file:///Users/chris/Projects/RetroFM/src/services/music/YouTubeMusicProvider.ts#L22-L26)
```typescript
22:           if (event.data.type === 'BOOMBOX_ACTION' && event.data.payload) {
23:             for (const listener of this.boomBoxActionListeners) {
24:               try { listener(event.data.payload); } catch (e) {}
25:             }
26:           }
```

In `src/App.tsx`, the action listener calls the ref-wrapped `handlePlayMusicRef`:
**File**: [`src/App.tsx`](file:///Users/chris/Projects/RetroFM/src/App.tsx#L589-L596)
```typescript
589:   useEffect(() => {
590:     const unsubAction = musicProviderRef.current.onBoomBoxAction(async (action: any) => {
591:       if (!action || !action.action) return;
592:       logMessage(`[Boom Box Action] ${action.action}`);
593:       switch (action.action) {
594:         case 'PLAY':
595:           await handlePlayMusicRef.current();
596:           break;
```

### Step 7: Complete `handlePlayMusic` & Helper Functions
**File**: [`src/App.tsx`](file:///Users/chris/Projects/RetroFM/src/App.tsx#L767-L801)
```typescript
767:   const handlePlayMusic = async () => {
768:     lastTransportCommandTimeRef.current = Date.now();
769:     logMessage('Sending Play command to YouTube tab...');
770:     // If not connected to a YouTube tab yet, launch RetroFM tab group or program the current song preset
771:     if (!playbackStatus.connectedTabId) {
772:       logMessage('No active YouTube tab connected. Launching tab group / programming selected song...');
773:       const groupRes = await musicProviderRef.current.launchRetroFmGroup();
774:       if (groupRes?.connectedTabId) {
775:         if (groupRes.status) setPlaybackStatus(groupRes.status);
776:       }
777:       await handleProgramSong();
778:       broadcastCurrentRadioState();
779:       return;
780:     }
781: 
782:     // If currently stopped at position 0, seek to 0 and start playback
783:     if (!playbackStatus.isPlaying && playbackStatus.currentTime === 0) {
784:       await musicProviderRef.current.seek(0).catch(() => {});
785:     }
786: 
787:     const ok = await musicProviderRef.current.play();
788:     if (ok) {
789:       if (volumeControllerRef.current) {
790:         await volumeControllerRef.current.syncInitialVolume('Play button pressed');
791:       }
792:       logMessage('▶ Playback started on YouTube tab.');
793:       setPlaybackStatus((prev) => ({ ...prev, isPlaying: true }));
794:       setTestResults((prev) => ({ ...prev, playbackControl: true }));
795:       broadcastCurrentRadioState();
796:     } else {
797:       logMessage('Play command failed or tab was idle. Attempting to program selected song...');
798:       await handleProgramSong();
799:       broadcastCurrentRadioState();
800:     }
801:   };
```
Helpers called:
- `musicProviderRef.current.launchRetroFmGroup()` (lines 166-191 of `YouTubeMusicProvider.ts`)
- `handleProgramSong()` (lines 880-940 of `App.tsx`)
- `musicProviderRef.current.seek(0)` (lines 334-342 of `YouTubeMusicProvider.ts`)
- `musicProviderRef.current.play()` (lines 304-312 of `YouTubeMusicProvider.ts`)
- `volumeControllerRef.current.syncInitialVolume()` (`VolumeController.ts`)
- `broadcastCurrentRadioState()` (lines 513-574 of `App.tsx`)

### Step 8: Provider Methods `play()` and `seek()`
**File**: [`src/services/music/YouTubeMusicProvider.ts`](file:///Users/chris/Projects/RetroFM/src/services/music/YouTubeMusicProvider.ts#L290-L342)
```typescript
290:   private async ensureConnected(): Promise<number | null> {
291:     if (this.connectedTabId) return this.connectedTabId;
292:     try {
293:       const tabs = await this.listTabs();
294:       if (tabs && tabs.length > 0) {
295:         const res = await this.connect(tabs[0].id);
296:         if (res.success && res.status) {
297:           return this.connectedTabId;
298:         }
299:       }
300:     } catch {}
301:     return null;
302:   }
303: 
304:   public async play(): Promise<boolean> {
305:     const tabId = await this.ensureConnected();
306:     if (!tabId) return false;
307:     const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
308:       tabId,
309:       command: { action: 'PLAY' },
310:     });
311:     return !!res?.success;
312:   }
...
334:   public async seek(seconds: number): Promise<boolean> {
335:     const tabId = await this.ensureConnected();
336:     if (!tabId) return false;
337:     const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
338:       tabId,
339:       command: { action: 'SEEK', time: seconds },
340:     });
341:     return !!res?.success;
342:   }
```

### Step 9: Background Worker Routing for `COMMAND_YOUTUBE`
**File**: [`extension/background.js`](file:///Users/chris/Projects/RetroFM/extension/background.js#L483-L504)
```javascript
483:       if (type === 'COMMAND_YOUTUBE') {
484:         const tabId = await resolveYouTubeTab(payload?.tabId);
485:         if (!tabId) {
486:           sendResponse({ success: false, error: 'No YouTube tab connected.' });
487:           return;
488:         }
489: 
490:         try {
491:           const result = await chrome.tabs.sendMessage(tabId, payload.command);
492:           sendResponse({ success: true, data: result });
493:         } catch (err) {
494:           // Retry once after ensuring content script is injected
495:           await ensureYouTubeScriptInjected(tabId);
496:           try {
497:             const result = await chrome.tabs.sendMessage(tabId, payload.command);
498:             sendResponse({ success: true, data: result });
499:           } catch (retryErr) {
500:             sendResponse({ success: false, error: 'Failed communicating with YouTube tab: ' + retryErr.message });
501:           }
502:         }
503:         return;
504:       }
```

### Step 10: Command Receiver & Execution in `content_youtube.js`
**File**: [`extension/content_youtube.js`](file:///Users/chris/Projects/RetroFM/extension/content_youtube.js#L29-L31,L192-L215)
```javascript
29:   function getVideoElement() {
30:     return document.querySelector('video.video-stream.html5-main-video') || document.querySelector('video');
31:   }
...
192:   // Listen for messages from background service worker
193:   chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
194:     const video = getVideoElement();
195: 
196:     switch (message.action) {
...
200:       case 'PLAY': {
201:         if (video) {
202:           // If a target volume is pending confirmation, give it a moment to apply before starting playback
203:           const startPlay = () => {
204:             return video.play().then(() => {
205:               sendResponse({ success: true, status: getPlaybackStatus() });
206:             }).catch((err) => {
207:               sendResponse({ success: false, error: err.message });
208:             });
209:           };
210: 
211:           startPlay();
212:           return true;
213:         }
214:         sendResponse({ success: false, error: 'Video element not found' });
215:         break;
216:       }
```

### Step 11: Role of `yt_main_world.js` in Playback Commands
**File**: [`extension/player/yt_main_world.js`](file:///Users/chris/Projects/RetroFM/extension/player/yt_main_world.js#L1-L150)
- `yt_main_world.js` runs in the `MAIN` page world of `youtube.com`.
- **Finding**: `yt_main_world.js` handles **only volume and mute synchronization** (`applyVolume(vol)`, `setVolume()`, `isMuted()`, `unMute()`).
- It **does not participate** in `PLAY`, `PAUSE`, `STOP`, or `SEEK` commands. Transport commands are executed directly on the DOM `<video>` element inside the isolated world in `content_youtube.js`.

### Step 12: Playback State Read & Reporting Back
**File**: [`extension/content_youtube.js`](file:///Users/chris/Projects/RetroFM/extension/content_youtube.js#L42-L69)
```javascript
42:   function getPlaybackStatus() {
43:     const video = getVideoElement();
44:     const reportedVolFraction = Number((latestPlayerVolume / 100).toFixed(2));
45: 
46:     if (!video) {
47:       return {
48:         available: false,
49:         title: getTitle(),
50:         url: window.location.href,
51:         isPlaying: false,
52:         currentTime: 0,
53:         duration: 0,
54:         volume: reportedVolFraction,
55:         muted: latestPlayerMuted
56:       };
57:     }
58: 
59:     return {
60:       available: true,
61:       title: getTitle(),
62:       url: window.location.href,
63:       isPlaying: !video.paused && !video.ended && video.readyState > 2,
64:       currentTime: Math.floor(video.currentTime),
65:       duration: Math.floor(video.duration || 0),
66:       volume: reportedVolFraction,
67:       muted: latestPlayerMuted || video.muted
68:     };
69:   }
```
`status` is returned in the response to `PLAY` (`sendResponse({ success: true, status: getPlaybackStatus() })`), and periodic status is gathered every 1 second by the poller in `App.tsx` (lines 648-684) calling `musicProviderRef.current.getStatus()`.

---

## 3. Trace Pause and Stop Separately

### 3.1 Trace of Pause

#### 1. Boom Box Button Listener & Dispatch
**File**: [`extension/player/player.js`](file:///Users/chris/Projects/RetroFM/extension/player/player.js#L35)
```javascript
35: act($('bPause'),()=>{sendBoomBoxAction('PAUSE');});
```
Dispatches `{ type: 'BOOMBOX_ACTION', payload: { action: 'PAUSE' } }` via `chrome.runtime.sendMessage`.

#### 2. Background Router
**File**: [`extension/background.js`](file:///Users/chris/Projects/RetroFM/extension/background.js#L216-L235)
Identifies `retroTabId` via `resolveRetroFmTab()` and forwards `BOOMBOX_ACTION` to `content_retrofm.js`.

#### 3. App Receiver & `handlePauseMusic`
**File**: [`src/App.tsx`](file:///Users/chris/Projects/RetroFM/src/App.tsx#L597-L599,L803-L818)
```typescript
597:         case 'PAUSE':
598:           await handlePauseMusicRef.current();
599:           break;
...
803:   const handlePauseMusic = async () => {
804:     lastTransportCommandTimeRef.current = Date.now();
805:     logMessage('Sending Pause command to YouTube tab...');
806:     // Synchronously update local playback status to paused immediately
807:     setPlaybackStatus((prev) => ({ ...prev, isPlaying: false, currentTime: prev.currentTime > 0 ? prev.currentTime : 1 }));
808:     broadcastCurrentRadioState();
809: 
810:     const ok = await musicProviderRef.current.pause();
811:     if (ok) {
812:       logMessage('⏸ Playback paused on YouTube tab.');
813:       setTestResults((prev) => ({ ...prev, playbackControl: true }));
814:     } else {
815:       logMessage('Notice: Pause command sent to YouTube tab.');
816:     }
817:     broadcastCurrentRadioState();
818:   };
```

#### 4. Provider Method `pause()`
**File**: [`src/services/music/YouTubeMusicProvider.ts`](file:///Users/chris/Projects/RetroFM/src/services/music/YouTubeMusicProvider.ts#L314-L322)
```typescript
314:   public async pause(): Promise<boolean> {
315:     const tabId = await this.ensureConnected();
316:     if (!tabId) return false;
317:     const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
318:       tabId,
319:       command: { action: 'PAUSE' },
320:     });
321:     return !!res?.success;
322:   }
```

#### 5. YouTube Content Script Execution
**File**: [`extension/content_youtube.js`](file:///Users/chris/Projects/RetroFM/extension/content_youtube.js#L217-L225)
```javascript
217:       case 'PAUSE': {
218:         if (video) {
219:           video.pause();
220:           sendResponse({ success: true, status: getPlaybackStatus() });
221:         } else {
222:           sendResponse({ success: false, error: 'Video element not found' });
223:         }
224:         break;
225:       }
```

---

### 3.2 Trace of Stop

#### 1. Boom Box Button Listener & Dispatch
**File**: [`extension/player/player.js`](file:///Users/chris/Projects/RetroFM/extension/player/player.js#L36)
```javascript
36: act($('bStop'),()=>{sendBoomBoxAction('STOP');});
```
Dispatches `{ type: 'BOOMBOX_ACTION', payload: { action: 'STOP' } }` via `chrome.runtime.sendMessage`.

#### 2. Background Router
**File**: [`extension/background.js`](file:///Users/chris/Projects/RetroFM/extension/background.js#L216-L235)
Forwards `BOOMBOX_ACTION` to `content_retrofm.js`.

#### 3. App Receiver & `handleStopMusic`
**File**: [`src/App.tsx`](file:///Users/chris/Projects/RetroFM/src/App.tsx#L600-L602,L820-L835)
```typescript
600:         case 'STOP':
601:           await handleStopMusicRef.current();
602:           break;
...
820:   const handleStopMusic = async () => {
821:     lastTransportCommandTimeRef.current = Date.now();
822:     logMessage('Sending Stop command to YouTube tab...');
823:     // Synchronously set local and broadcast state to stopped at position 0 immediately
824:     setPlaybackStatus((prev) => ({ ...prev, isPlaying: false, currentTime: 0 }));
825:     broadcastCurrentRadioState();
826: 
827:     const ok = await musicProviderRef.current.stop();
828:     if (ok) {
829:       logMessage('⏹ Playback stopped on YouTube tab.');
830:       setTestResults((prev) => ({ ...prev, playbackControl: true }));
831:     } else {
832:       logMessage('Stop command sent (transport reset to stopped).');
833:     }
834:     broadcastCurrentRadioState();
835:   };
```

#### 4. Provider Method `stop()`
**File**: [`src/services/music/YouTubeMusicProvider.ts`](file:///Users/chris/Projects/RetroFM/src/services/music/YouTubeMusicProvider.ts#L324-L332)
```typescript
324:   public async stop(): Promise<boolean> {
325:     const tabId = await this.ensureConnected();
326:     if (!tabId) return false;
327:     const res = await this.sendExtensionMessage('COMMAND_YOUTUBE', {
328:       tabId,
329:       command: { action: 'STOP' },
330:     });
331:     return !!res?.success;
332:   }
```

#### 5. YouTube Content Script Execution
**File**: [`extension/content_youtube.js`](file:///Users/chris/Projects/RetroFM/extension/content_youtube.js#L226-L235)
```javascript
226:       case 'STOP': {
227:         if (video) {
228:           video.pause();
229:           video.currentTime = 0;
230:           sendResponse({ success: true, status: getPlaybackStatus() });
231:         } else {
232:           sendResponse({ success: false, error: 'Video element not found' });
233:         }
234:         break;
235:       }
```

### 3.3 Command Collision, Mutation & Timing Analysis

1. **Does Stop issue both a pause and a seek?**
   - In `content_youtube.js` line 228-229:
     ```javascript
     video.pause();
     video.currentTime = 0;
     ```
     `STOP` executes `video.pause()` followed by setting `video.currentTime = 0` synchronously in a single message handler invocation. It does **not** send a separate `SEEK` message.
2. **Does a seek trigger a new playback action?**
   - Setting `video.currentTime = 0` on an already paused `<video>` element emits native `seeking` and `seeked` events, but **does not invoke `play()`** or change `video.paused` from `true` to `false`.
3. **Can a status update accidentally cause Play to be called?**
   - The status poller in `App.tsx` (lines 648-684) only calls `musicProviderRef.current.getStatus()` and `setPlaybackStatus()`. It has **no** call to `handlePlayMusic` or `musicProvider.play()`.
4. **Where can commands be duplicated or overwritten?**
   - In `handlePlayMusic` (line 787), if `musicProviderRef.current.play()` returns `false` (e.g., if YouTube video was unbuffered or video tag threw), it enters fallback line 798: `await handleProgramSong()`, which executes a fresh search and navigation, navigating the YouTube tab to a new URL.
   - Poller race protection: `lastTransportCommandTimeRef.current` creates a 2.5s window where status polling cannot overwrite `isPlaying` with a stale frame from YouTube.

---

## 4. Trace the Button Active State

### 4.1 HTML Elements
**File**: [`extension/player/index.html`](file:///Users/chris/Projects/RetroFM/extension/player/index.html#L15,L20-L22)
```html
15:   <polygon id="gPlay" class="lit" points="433.2,555.2 433,563.8 448.2,559.4"/><polygon id="gStop" class="lit" points="486.2,556.2 498.1,556 497.9,563.1 485.3,562.9"/><g id="gPause"><polygon class="lit gp" points="538.1,555.5 542.3,555.9 541.3,563.4 537.3,563"/><polygon class="lit gp" points="546,555.3 549.4,555 548.8,562.8 545.3,563"/></g>
...
20:  <div class="hit btn" id="bPlay" role="button" aria-label="Play" tabindex="0" style="left:412px"></div>
21:  <div class="hit btn" id="bStop" role="button" aria-label="Stop" tabindex="0" style="left:465px"></div>
22:  <div class="hit btn" id="bPause" role="button" aria-label="Pause" tabindex="0" style="left:518px"></div>
```

### 4.2 CSS Classes & Selectors
**File**: [`extension/player/player.css`](file:///Users/chris/Projects/RetroFM/extension/player/player.css#L38-L43,L46-L47)
```css
38: .hit{cursor:pointer;border-radius:6px}
39: .btn{width:54px;height:54px;top:544px}
40: .btn.on{background:none;box-shadow:none}
41: .lit{fill:#ffb54a;stroke:#ffb54a;stroke-width:.8;stroke-linejoin:round;opacity:0;transition:opacity .3s;filter:drop-shadow(0 0 3px #ff9a1f) drop-shadow(0 0 8px rgba(255,150,30,.75))}.lit.on{opacity:1}
42: .lit.rec{fill:#ff4a3a;stroke:#ff4a3a;filter:drop-shadow(0 0 3px #ff2a1a) drop-shadow(0 0 9px rgba(255,40,30,.85))}
43: .btn:active{background:rgba(0,0,0,.35)}
...
46: .reel{border-radius:50%;background-image:var(--img);background-size:1408px 768px;animation:spin 1.6s linear infinite;animation-play-state:paused}
47: .playing .reel{animation-play-state:running}
```

### 4.3 Function Changing State
**File**: [`extension/player/player.js`](file:///Users/chris/Projects/RetroFM/extension/player/player.js#L24-L32)
```javascript
24: function setState(s,quiet){S.state=s;
25:  $('bPlay').classList.toggle('on',s==='playing');$('bPause').classList.toggle('on',s==='paused');
26:  $('gPlay').classList.toggle('on',s==='playing');document.querySelectorAll('.gp').forEach(e=>e.classList.toggle('on',s==='paused'));
27:  $('gStop').classList.remove('on');
28:  $('stage').classList.toggle('playing',s==='playing');
29:  $('st').textContent=s==='playing'?'\u25B6 PLAYING':s==='paused'?'\u275A\u275A PAUSED':'\u25A0 STOPPED';
30:  if(s==='paused'||s==='stopped'||s==='playing'){renderSong();}
31:  if(!vuRunning){vuRunning=true;requestAnimationFrame(vu);}
32:  if(!quiet)emit('transport',{state:s});}
```

### 4.4 All Call Sites Invoking `setState`
1. Line 90 of `player.js`:
   ```javascript
   window.RetroFM={setSongYear,setSong,setTransport:s=>setState(s,true)};
   ```
2. Line 363 of `player.js`:
   ```javascript
   function setVisualTransport(state) {
     if (state === 'playing' || state === 'paused' || state === 'stopped') {
       setState(state, true);
     }
   }
   ```
   Invoked by `applyRadioState(state)` (line 399) upon receipt of authoritative `RADIO_STATE` message or `GET_RADIO_STATE` response.

### 4.5 Answers to Specific Button Active State Questions

1. **What exact event makes Play become active?**
   - The arrival of a `RADIO_STATE` message (or response to `GET_RADIO_STATE`) with `state.playbackStatus === 'playing'`, which calls `setVisualTransport('playing')` -> `setState('playing', true)`.
   - `$('gPlay').classList.toggle('on', true)` turns opacity to 1 via `.lit.on`.
2. **What exact event makes Pause become active?**
   - The arrival of `RADIO_STATE` with `state.playbackStatus === 'paused'`, calling `setVisualTransport('paused')` -> `setState('paused', true)`.
   - `document.querySelectorAll('.gp').forEach(e => e.classList.toggle('on', true))` turns pause polygons opacity to 1 via `.lit.on`.
3. **What exact event makes Stop become active, if Stop has an active state?**
   - Stop **does not have a persistent illuminated active state**.
   - Line 27: `$('gStop').classList.remove('on');`. When stopped, Play, Pause, and Stop indicators are all unilluminated (`opacity: 0`). The display `#st` shows `■ STOPPED`.
4. **Does the indicator represent the user's most recent click, the command being processed, or the actual YouTube playback state?**
   - It represents the **authoritative radio state broadcasted by RetroFM App**, which derives from the verified YouTube status (or optimistic command acknowledgment in `App.tsx`). It does **not** illuminate on user click.
5. **Can a delayed status message turn an indicator off or on after a newer command?**
   - In `App.tsx`, lines 653-663 mitigate this with a 2500ms timestamp guard (`lastTransportCommandTimeRef`). If a poll response arrives within 2.5s of an explicit transport command, it merges metadata but does not overwrite `isPlaying` or zero-out `currentTime`.
6. **Is there any code that updates the visual state without confirming that the corresponding media action occurred?**
   - In `App.tsx` lines 807 and 824, `handlePauseMusic` and `handleStopMusic` update local state synchronously and call `broadcastCurrentRadioState()` immediately before awaiting `pause()` / `stop()` on YouTube. If the YouTube call times out or fails, the state was already broadcasted.
7. **Does the UI distinguish between a command being sent, a command succeeding, and playback actually starting?**
   - No. There is no intermediate "loading" or "buffering" light on the boom box faceplate. The states are strictly `'playing'`, `'paused'`, or `'stopped'`.

---

## 5. Inspect Playback State and Polling

### 5.1 Playback State Types & Initial Values
**File**: [`src/services/music/types.ts`](file:///Users/chris/Projects/RetroFM/src/services/music/types.ts#L1-L11)
```typescript
1: export interface MusicPlaybackStatus {
2:   available: boolean;
3:   title: string;
4:   url: string;
5:   isPlaying: boolean;
6:   currentTime: number;
7:   duration: number;
8:   volume: number; // 0.0 to 1.0
9:   muted: boolean;
10:   connectedTabId?: number | null;
11: }
```

**File**: [`src/App.tsx`](file:///Users/chris/Projects/RetroFM/src/App.tsx#L169-L179)
```typescript
169:   const [playbackStatus, setPlaybackStatus] = useState<MusicPlaybackStatus>({
170:     available: false,
171:     title: 'Unknown Video',
172:     url: '',
173:     isPlaying: false,
174:     currentTime: 0,
175:     duration: 0,
176:     volume: 1,
177:     muted: false,
178:     connectedTabId: null
179:   });
```

Boom Box local state in [`extension/player/player.js`](file:///Users/chris/Projects/RetroFM/extension/player/player.js#L14):
```javascript
14: const S={state:'stopped',vol:.7,bal:.5,tun:(98.7-87.5)/20.5,dec:1970};
```

### 5.2 Status Poller Mechanism
**File**: [`src/App.tsx`](file:///Users/chris/Projects/RetroFM/src/App.tsx#L645-L684)
```typescript
645:   // --- Poll YouTube Tab Status ---
646:   useEffect(() => {
647:     if (!playbackStatus.connectedTabId) return;
648: 
649:     const poll = async () => {
650:       try {
651:         const s = await musicProviderRef.current.getStatus();
652:         // If a transport command was executed within the last 2.5 seconds,
653:         // do not let a transitional or lagging poll result overwrite the user's explicit action
654:         const timeSinceCmd = Date.now() - lastTransportCommandTimeRef.current;
655:         if (timeSinceCmd > 2500) {
656:           setPlaybackStatus(s);
657:         } else {
658:           // Merge non-transport properties (volume, title, url) while preserving recent transport state
659:           setPlaybackStatus((prev) => ({
660:             ...s,
661:             isPlaying: prev.isPlaying,
662:             currentTime: prev.currentTime === 0 && !prev.isPlaying ? 0 : s.currentTime
663:           }));
664:         }
665: 
666:         if (s.available) {
667:           setTestResults((prev) => ({
668:             ...prev,
669:             playbackState: true,
670:             currentPosition: s.currentTime > 0 || prev.currentPosition,
671:             metadata: !!(s.title && s.title !== 'Unknown Title') || prev.metadata
672:           }));
673:           if (s.volume !== undefined && volumeControllerRef.current) {
674:             volumeControllerRef.current.handlePolledVolume(s.volume);
675:           }
676:         }
677:       } catch (err) {
678:         // Status fetch error
679:       }
680:     };
681: 
682:     poll();
683:     const timer = setInterval(poll, 1000);
684:     return () => clearInterval(timer);
685:   }, [playbackStatus.connectedTabId]);
```

### 5.3 Authoritative Broadcast to Boom Box
**File**: [`src/App.tsx`](file:///Users/chris/Projects/RetroFM/src/App.tsx#L513-L574)
```typescript
513:   const broadcastCurrentRadioState = useCallback(() => {
514:     const vc = volumeControllerRef.current;
515:     const currentVol = vc ? vc.getUserVolume() : targetMusicVolume;
516:     const isDuck = vc ? vc.getState() !== 'idle' : isDuckingActive;
517: 
518:     // Preserve valid song metadata across playing, paused, and stopped states
519:     let currentSong = null;
520:     if (programSongResult && programSongResult.selectedTitle) {
521:       currentSong = {
522:         title: programSongResult.selectedTitle,
523:         artist: programArtist || '',
524:         year: programYear || '',
525:         duration: programSongResult.selectedDuration
526:       };
527:     } else if (playbackStatus && playbackStatus.title && playbackStatus.title !== 'Unknown Title' && playbackStatus.title !== 'Unknown Video') {
528:       currentSong = {
529:         title: playbackStatus.title,
530:         artist: programArtist || '',
531:         year: programYear || ''
532:       };
533:     } else if (programSongTitle) {
534:       currentSong = {
535:         title: programSongTitle,
536:         artist: programArtist || '',
537:         year: programYear || ''
538:       };
539:     }
540: 
541:     const yearNum = parseInt(programYear, 10);
542:     const decade = (!isNaN(yearNum) && yearNum >= 1960 && yearNum <= 2029)
543:       ? Math.floor(yearNum / 10) * 10
544:       : 1980;
...
559:     const statePayload = {
560:       playbackStatus: playbackStatus.isPlaying ? 'playing' : (playbackStatus.available && playbackStatus.currentTime > 0 ? 'paused' : 'stopped'),
561:       currentSong,
562:       date: programYear ? `${programYear}-07-04` : '1985-07-13',
563:       decade,
564:       frequency: station.freq,
565:       genre: station.genre,
566:       masterVolume: currentVol,
567:       duckLevel: vc ? vc.getDuckLevel() : duckVolumePercent,
568:       isDucking: isDuck,
569:       appConnected: true,
570:       timestamp: Date.now()
571:     };
572: 
573:     musicProviderRef.current.broadcastRadioState(statePayload).catch(() => {});
574:   }, [playbackStatus, programSongResult, programArtist, programSongTitle, programYear, targetMusicVolume, isDuckingActive, duckVolumePercent]);
```

### 5.4 How the Application Distinguishes States
1. **A song has been selected but has not started playing**:
   - `programSongResult` or `programSongTitle` is set.
   - `playbackStatus.isPlaying` is `false`.
   - `playbackStatus.currentTime` is `0`.
   - State evaluates to: `playbackStatus: 'stopped'`, `currentSong: { title, artist }`.
2. **A song is actively playing**:
   - `playbackStatus.isPlaying === true`.
   - State evaluates to: `playbackStatus: 'playing'`.
3. **A song is paused**:
   - `playbackStatus.isPlaying === false` and `playbackStatus.available === true && playbackStatus.currentTime > 0`.
   - State evaluates to: `playbackStatus: 'paused'`.
4. **A song is stopped at time zero**:
   - `playbackStatus.isPlaying === false` and `playbackStatus.currentTime === 0`.
   - State evaluates to: `playbackStatus: 'stopped'`.
5. **A Play command was sent but playback has not started**:
   - `lastTransportCommandTimeRef` is set to `Date.now()`.
   - In `handlePlayMusic`, if `ok` is true, it optimistically sets `isPlaying: true`.
   - If not yet connected, it launches the tab group and calls `handleProgramSong()`.
6. **A Play command failed or was blocked**:
   - If `musicProviderRef.current.play()` returns `false`, `handlePlayMusic` falls back to `handleProgramSong()`.
7. **A Stop command was sent but video has not yet stopped**:
   - Synchronously updates local `playbackStatus` to `{ isPlaying: false, currentTime: 0 }` immediately, setting `lastTransportCommandTimeRef` so poller results will not resurrect playback state for 2.5s.

---

## 6. Inspect Chrome Tab Selection and Playback Execution

### 6.1 `resolveRetroFmTab()`
**File**: [`extension/background.js`](file:///Users/chris/Projects/RetroFM/extension/background.js#L32-L61)
```javascript
33: async function resolveRetroFmTab(requestedTabId) {
34:   if (requestedTabId) {
35:     try {
36:       const tab = await chrome.tabs.get(requestedTabId);
37:       if (tab) return tab.id;
38:     } catch (e) {}
39:   }
40:   if (activeRetroFmTabId) {
41:     try {
42:       const tab = await chrome.tabs.get(activeRetroFmTabId);
43:       if (tab) return tab.id;
44:     } catch (e) {
45:       activeRetroFmTabId = null;
46:     }
47:   }
48:   try {
49:     const tabs = await chrome.tabs.query({});
50:     const matchingTabs = tabs.filter(t => t.url && (
51:       t.url.includes('localhost') ||
52:       t.url.includes('127.0.0.1') ||
53:       t.url.includes('.run.app')
54:     ));
55:     if (matchingTabs.length > 0) {
56:       const active = matchingTabs.find(t => t.active) || matchingTabs[0];
57:       activeRetroFmTabId = active.id;
58:       return active.id;
59:     }
60:   } catch (e) {}
61:   return null;
62: }
```

### 6.2 `resolveYouTubeTab()`
**File**: [`extension/background.js`](file:///Users/chris/Projects/RetroFM/extension/background.js#L113-L146)
```javascript
113: async function resolveYouTubeTab(requestedTabId) {
114:   if (requestedTabId) {
115:     try {
116:       const tab = await chrome.tabs.get(requestedTabId);
117:       if (tab && tab.url && tab.url.includes('youtube.com')) {
118:         await ensureYouTubeScriptInjected(tab.id);
119:         return tab.id;
120:       }
121:     } catch (e) {
122:       // Tab might have closed
123:     }
124:   }
125: 
126:   if (activeConnectedTabId) {
127:     try {
128:       const tab = await chrome.tabs.get(activeConnectedTabId);
129:       if (tab && tab.url && tab.url.includes('youtube.com')) {
130:         await ensureYouTubeScriptInjected(tab.id);
131:         return tab.id;
132:       }
133:     } catch (e) {
134:       activeConnectedTabId = null;
135:     }
136:   }
137: 
138:   const tabs = await listYouTubeTabs();
139:   const activeTab = tabs.find(t => t.active) || tabs[0];
140:   if (activeTab) {
141:     activeConnectedTabId = activeTab.id;
142:     await ensureYouTubeScriptInjected(activeTab.id);
143:     return activeTab.id;
144:   }
145:   return null;
146: }
```

### 6.3 Message Forwarding, Error Detection & Retries
In `COMMAND_YOUTUBE` ([`extension/background.js:490-502`](file:///Users/chris/Projects/RetroFM/extension/background.js#L490-L502)):
- Tries `chrome.tabs.sendMessage(tabId, payload.command)`.
- If an error occurs (e.g., "Receiving end does not exist"), it executes `ensureYouTubeScriptInjected(tabId)`:
  ```javascript
  await ensureYouTubeScriptInjected(tabId);
  try {
    const result = await chrome.tabs.sendMessage(tabId, payload.command);
    sendResponse({ success: true, data: result });
  } catch (retryErr) {
    sendResponse({ success: false, error: 'Failed communicating with YouTube tab: ' + retryErr.message });
  }
  ```
- If injection or second attempt fails, it returns an explicit error string.

---

## 7. Check the YouTube Player Execution Logic

Based strictly on code inspection in `content_youtube.js`:

1. **Does Play call `video.play()` or an equivalent player API?**
   - It calls `video.play()`. (Line 204: `return video.play().then(...)`).
2. **Does it await the resulting promise?**
   - Yes, via `.then(...)` on the returned Promise.
3. **Does it handle rejected promises?**
   - Yes: `.catch((err) => { sendResponse({ success: false, error: err.message }); })`.
4. **Does it verify that `video.paused` becomes false?**
   - In `startPlay()`: It responds with `getPlaybackStatus()` inside `.then()`, where `isPlaying: !video.paused && !video.ended && video.readyState > 2`. It does not poll or assert `!video.paused`.
5. **Does it verify that `currentTime` advances?**
   - No. It returns the instantaneous `currentTime` right as the play promise resolves.
6. **Does it depend on the YouTube tab being active or visible?**
   - No explicit check for visibility or tab focus exists in the code.
7. **Does it rely on a click or other user gesture in the YouTube tab?**
   - No user gesture is performed in the YouTube tab; the command is triggered via extension message calling `video.play()` directly in the content script.
8. **Can the browser's autoplay policy block playback?**
   - If Chrome blocks un-gestured playback across origins, `video.play()` rejects with a `NotAllowedError`. This is caught by `.catch((err) => { sendResponse({ success: false, error: err.message }); })`.
9. **Can another handler pause the video immediately after Play?**
   - No other handler in RetroFM's content scripts calls pause after play.
10. **Does Stop merely pause, pause and seek to zero, or perform another operation?**
    - Lines 228-229: `video.pause(); video.currentTime = 0;`. It pauses and seeks to 0.
11. **Can seeking to zero trigger playback through another event handler?**
    - In `content_youtube.js`, there is no `seeked` event listener that invokes `play()`. The only event listeners on `video` are `volumechange` and `timeupdate`.

---

## 8. Review Existing Tests

**File**: [`scripts/test-boombox-integration.ts`](file:///Users/chris/Projects/RetroFM/scripts/test-boombox-integration.ts)

### 8.1 What Existing Tests Assert vs. Real Chrome Playback
- **Test Suite 1 (Presets)**: Asserts the 5 static objects in `HARDCODED_PRESETS` match expected strings. (Unit test on TypeScript objects).
- **Test Suite 2 (Malformed State)**: Asserts string sanitization function returns null for undefined/null inputs. (Unit test).
- **Test Suite 3 (State Contract)**: Asserts dummy interface object fields are valid. (Unit test).
- **Test Suite 4 (Volume Feedback Protection)**: Asserts that a simulated function counter doesn't increment when visual updates arrive. (Simulation).
- **Test Suite 5 (Tab Management)**: Asserts mock array operations for tab reuse. (Simulation).
- **Test Suite 6 (Tab Resolution)**: Asserts a regex filter on mock tab URLs returns the index with `localhost`. (Simulation).
- **Test Suite 7 (Title Cleaning)**: Asserts regex transformations remove release years and leading artists from raw title strings. (Unit test).
- **Test Suite 8 (Transport Active States)**: Asserts a pure function returns `{ playActive: true, pauseActive: false, stopActive: false }`. (Unit test).
- **Test Suite 9 (Seek Math)**: Asserts `Math.max(0, current - 10)` returns expected integers. (Unit test).
- **Test Suite 10 (CSS Properties)**: Inspects the raw text of `player.css` using `readFileSync` to confirm specific hex color strings exist. (Static text analysis).
- **Test Suite 11 (Metadata Retention)**: Asserts that simulated render and state update functions do not wipe title on pause or stop. (Unit test).

**Critical Finding**: None of the tests in `scripts/test-boombox-integration.ts` execute within an actual running Chrome browser instance, connect to the Chrome Extensions API (`chrome.runtime`, `chrome.tabs`), or control a real YouTube tab. They verify logic, sanitization, and state contracts, but cannot verify live Chrome IPC or Web Audio / YouTube sandbox policies.

---

## 9. Reviewer's Guide: Exact Files & Functions

When reviewing or designing fixes for Boom Box playback controls, inspect these files and functions:

| Repository File | Functions / Components to Inspect | Purpose |
| :--- | :--- | :--- |
| `extension/player/player.js` | `act`, `sendBoomBoxAction`, `setState`, `setVisualTransport`, `applyRadioState` | Boom Box UI transport clicks, visual feedback, and incoming state binding |
| `extension/player/index.html` | `#bPlay`, `#bPause`, `#bStop`, `#gPlay`, `#gPause`, `#gStop` | DOM hit targets and SVG illumination markers |
| `extension/player/player.css` | `.hit`, `.btn`, `.lit`, `.gp`, `#sg` | Active button glow and transition styling |
| `extension/background.js` | `handleIncomingRequest`, `resolveRetroFmTab`, `resolveYouTubeTab`, `resolveBoomBoxTab` | Inter-tab routing for `BOOMBOX_ACTION`, `BROADCAST_RADIO_STATE`, `COMMAND_YOUTUBE` |
| `extension/content_retrofm.js` | `onWindowMessage`, `chrome.runtime.onMessage.addListener` | Bridge between extension IPC and localhost app window |
| `src/services/music/YouTubeMusicProvider.ts` | `onBoomBoxAction`, `play`, `pause`, `stop`, `seek`, `sendExtensionMessage` | Web application extension provider client |
| `src/App.tsx` | `handlePlayMusic`, `handlePauseMusic`, `handleStopMusic`, `handleRewindMusic`, `handleFastForwardMusic`, `broadcastCurrentRadioState`, `poll` | Authoritative playback coordinator and poller |
| `extension/content_youtube.js` | `getVideoElement`, `getPlaybackStatus`, `chrome.runtime.onMessage.addListener` | Direct execution on native YouTube `<video>` tag |
| `extension/player/yt_main_world.js` | `applyVolume`, `broadcastStatus` | YouTube main world volume bridge (does not touch transport) |
| `scripts/test-boombox-integration.ts` | Test Suites 1 through 11 | State contract regression tests |

---

## 10. Summary of File Modifications
During this task:
- Created: `BOOMBOX_PLAYBACK_SOURCE_REVIEW.md`
- No source code, tests, configuration, extension bundle, or database files were modified.
