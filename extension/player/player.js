const $=id=>document.getElementById(id);
if (document.title !== 'RetroFM') document.title = 'RetroFM';
const emit=(n,d)=>document.dispatchEvent(new CustomEvent('retrofm:'+n,{detail:d}));
const clamp=(v,a=0,b=1)=>Math.min(b,Math.max(a,v));
// scale stage to window width
const wrap=$('wrap'),stage=$('stage');
const fit=()=>{const s=wrap.clientWidth/1408;stage.style.transform='translate(0,'+(-92*s)+'px) scale('+s+')'};
new ResizeObserver(fit).observe(wrap);fit();
// scale the whole player (boom box, display, footer) with the window width; designed at 450px wide
const app=$('app');
function scaleApp(){const w=document.documentElement.clientWidth,h=document.documentElement.clientHeight,ah=app.offsetHeight,s=Math.min(3,Math.max(.3,Math.min(w/450,(h-4)/ah)));
 app.style.transform='scale('+s+')';app.style.marginLeft=Math.max(0,(w-450*s)/2)+'px';app.style.marginBottom=(ah*s-ah)+'px'}
new ResizeObserver(scaleApp).observe(app);addEventListener('resize',scaleApp);scaleApp();

const S={state:'stopped',vol:.7,bal:.5,tun:(100.3-87.5)/20.5,dec:1990};
const ST={
1960:[['Top 40/Pop',95.1],['Motown',101.5],['Soul',107.1],['R&B',93.5],['Freeform/Underground',99.5],['Folk Rock',102.7],['Psychedelic Rock',104.1]],
1970:[['AOR',95.5],['Disco',98.7],['Progressive Rock',92.3],['Soft Rock',103.5],['Funk',107.5],['Punk Rock',91.1],['Outlaw Country',97.1]],
1980:[['New Wave',90.7],['Synth-Pop',93.1],['Hair Metal',105.5],['Hip-Hop',89.9],['CHR',101.9],['Urban Contemporary',97.9],['College Rock',88.9]],
1990:[['Grunge',99.9],['Alternative Rock',106.7],['Gangsta Rap',92.7],['Contemporary R&B',105.1],['Teen Pop',100.3],['Eurodance',96.3],['Country Pop',94.7]],
2000:[['Nu-Metal',93.7],['Post-Grunge',107.3],['Emo',91.3],['Crunk',106.1],['Electropop',102.3],['Indie Rock',90.3],['Reggaeton',96.7]],
2010:[['EDM',101.1],['Trap',104.5],['Indie Pop',91.9],['Mumble Rap',99.1],['Synthwave',89.3],['Afrobeats',105.9]],
2020:[['Bedroom Pop',88.1],['Hyperpop',90.9],['Amapiano',103.9],['Drift Phonk',95.9],['Regional Mexican',102.9],['Lofi Hip-Hop',88.5]]};
let hasFirstSongStartedPlaying = false;
let isStartupReady = false;
let transientStatus = null;
let transientTimer = null;
let playbackEnabled = false;
let isSeeking = false;
let seekSafetyTimer = null;

function setSeekingState(active) {
  isSeeking = Boolean(active);
  if (seekSafetyTimer) {
    clearTimeout(seekSafetyTimer);
    seekSafetyTimer = null;
  }
  if (isSeeking) {
    seekSafetyTimer = setTimeout(() => {
      if (isSeeking) {
        isSeeking = false;
        updateStatusDisplay();
      }
    }, 12000);
  }
  updateStatusDisplay();
}

// Local Web Audio static noise generator
class StaticNoiseController {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.filter = null;
    this.gain = null;
    this.isPlaying = false;
    this.noiseBuffer = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  getBuffer(ctx) {
    if (!this.noiseBuffer || this.noiseBuffer.sampleRate !== ctx.sampleRate) {
      const bufferSize = ctx.sampleRate * 2;
      this.noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
    }
    return this.noiseBuffer;
  }

  start(volume) {
    if (this.isPlaying) {
      this.setVolume(volume);
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx) return;

    try {
      const buffer = this.getBuffer(ctx);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      // Analog radio bandpass filter centered around ~1400Hz
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1400, ctx.currentTime);
      filter.Q.setValueAtTime(0.7, ctx.currentTime);

      const gain = ctx.createGain();
      const targetGain = Math.max(0, (typeof volume === 'number' ? volume : S.vol) * 0.22);
      gain.gain.setValueAtTime(targetGain, ctx.currentTime);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      source.start();

      this.source = source;
      this.filter = filter;
      this.gain = gain;
      this.isPlaying = true;
    } catch (e) {
      console.warn('[StaticNoiseController] Start error:', e);
    }
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    if (this.gain && this.ctx) {
      try {
        this.gain.gain.setValueAtTime(this.gain.gain.value, this.ctx.currentTime);
        this.gain.gain.linearRampToValueAtTime(0.0001, this.ctx.currentTime + 0.02);
      } catch (e) {}
    }
    const src = this.source;
    this.source = null;
    this.filter = null;
    this.gain = null;
    setTimeout(() => {
      try {
        if (src) src.stop();
      } catch (e) {}
    }, 25);
  }

  setVolume(volume) {
    if (!this.isPlaying || !this.gain || !this.ctx) return;
    try {
      const targetGain = Math.max(0, volume * 0.22);
      this.gain.gain.setValueAtTime(targetGain, this.ctx.currentTime);
    } catch (e) {}
  }

  dispose() {
    this.stop();
    if (this.ctx) {
      try { this.ctx.close(); } catch (e) {}
      this.ctx = null;
    }
  }
}
const staticController = new StaticNoiseController();

const SEG_ALPHA_MAP = {
  'A': ['a','b','c','e','f','g'],
  'B': ['c','d','e','f','g'],
  'C': ['a','d','e','f'],
  'D': ['b','c','d','e','g'],
  'E': ['a','d','e','f','g'],
  'F': ['a','e','f','g'],
  'G': ['a','c','d','e','f'],
  'H': ['b','c','e','f','g'],
  'I': ['b','c'],
  'J': ['b','c','d','e'],
  'K': ['b','d','e','f','g'],
  'L': ['d','e','f'],
  'M': ['a','c','e','g'],
  'N': ['c','e','g'],
  'O': ['a','b','c','d','e','f'],
  'P': ['a','b','e','f','g'],
  'Q': ['a','b','c','f','g'],
  'R': ['e','g'],
  'S': ['a','c','d','f','g'],
  'T': ['d','e','f','g'],
  'U': ['b','c','d','e','f'],
  'V': ['c','d','e'],
  'W': ['c','d','e'],
  'X': ['b','c','e','f','g'],
  'Y': ['b','c','d','f','g'],
  'Z': ['a','b','d','e','g']
};

function render7SegStatus(mode) {
  if (!mode || mode === 'blank') return '';
  const CONFIG = {
    playing: { sym: '\u25B6', text: 'PLAY' },
    paused: { sym: '\u275A\u275A', text: 'PAUSE' },
    stopped: { sym: '\u25A0', text: 'STOP' },
    seek: { sym: '\u25B6\u25B6', text: 'SEEK' },
    seeking: { sym: '\u25B6\u25B6', text: 'SEEK' },
    rew: { sym: '\u25C0\u25C0', text: 'REW' },
    rewind: { sym: '\u25C0\u25C0', text: 'REW' },
    ff: { sym: '\u25B6\u25B6', text: 'FF' },
    forward: { sym: '\u25B6\u25B6', text: 'FF' },
    disconnected: { sym: '\u25A0', text: 'DISCONNECTED' }
  };
  const cfg = CONFIG[mode] || { sym: '', text: String(mode).toUpperCase() };
  const fullLabel = (cfg.sym ? cfg.sym + ' ' : '') + cfg.text;
  let h = '<span class="seg-st-display" aria-label="' + fullLabel + '">';
  if (cfg.sym) {
    h += '<span class="seg-st-sym">' + cfg.sym + '</span> ';
  }
  h += '<span class="sr-only">' + cfg.text + '</span>';
  h += '<span class="seg-st-text" aria-hidden="true">' + cfg.text + '</span>';
  h += '<span class="seg-st-chars" aria-hidden="true">';
  for (const ch of cfg.text) {
    const segs = SEG_ALPHA_MAP[ch];
    if (segs) {
      const on = new Set(segs);
      h += '<span class="seg-st-char">';
      for (const s of ['a','b','c','d','e','f','g']) {
        h += '<span class="seg-st-bar seg-st-' + s + (on.has(s) ? ' on' : '') + '"></span>';
      }
      h += '</span>';
    } else if (ch === ' ') {
      h += '<span style="width:4px"></span>';
    }
  }
  h += '</span></span>';
  return h;
}

function updateStatusDisplay() {
  const stEl = $('st');
  if (!stEl) return;
  if (!S.locked) {
    stEl.innerHTML = '';
    return;
  }
  if (!appConnected) {
    stEl.innerHTML = render7SegStatus('disconnected');
    return;
  }
  if (isSeeking || transientStatus === 'seek' || S.state === 'seek') {
    stEl.innerHTML = render7SegStatus('seek');
    return;
  }
  if (transientStatus) {
    stEl.innerHTML = render7SegStatus(transientStatus);
    return;
  }
  if (!hasFirstSongStartedPlaying || S.state === 'blank' || S.state === 'stopped') {
    stEl.innerHTML = '';
    return;
  }
  stEl.innerHTML = render7SegStatus(S.state);
}

function clearTransientStatus() {
  if (transientTimer) {
    clearTimeout(transientTimer);
    transientTimer = null;
  }
  if (transientStatus !== null) {
    transientStatus = null;
    updateStatusDisplay();
  }
}

function showTransientStatus(mode) {
  if (transientTimer) { clearTimeout(transientTimer); transientTimer = null; }
  transientStatus = mode;
  updateStatusDisplay();
  transientTimer = setTimeout(() => {
    transientStatus = null;
    transientTimer = null;
    updateStatusDisplay();
  }, 1000);
}

// transport
function setState(s,quiet){
 const normalized = (s === 'playing' || s === 'paused') ? s : (s === 'blank' ? 'blank' : 'stopped');
 const prevState = S.state;
 S.state = (normalized === 'blank') ? 'stopped' : normalized;
 $('bPlay').classList.toggle('on', normalized === 'playing');
 $('bPause').classList.toggle('on', normalized === 'paused');
 $('gPlay').classList.toggle('on', normalized === 'playing');
 document.querySelectorAll('.gp').forEach(e => e.classList.toggle('on', normalized === 'paused'));
 if (normalized === 'stopped') {
   $('gStop').classList.add('on');
   $('bStop').classList.add('on');
   setTimeout(() => {
     $('gStop').classList.remove('on');
     $('bStop').classList.remove('on');
   }, 1000);
 } else {
   $('gStop').classList.remove('on');
   $('bStop').classList.remove('on');
 }
 $('stage').classList.toggle('playing', normalized === 'playing');

 updateStatusDisplay();
 updateGenrePills();

 if (normalized === 'stopped' || normalized === 'blank' || (prevState !== 'playing' && prevState !== 'paused')) {
   renderSong();
 } else if (normalized === 'playing' || normalized === 'paused') {
   if (!sTimer && !sFadeTimer) {
     scheduleSongFade();
   }
 }
 if (!vuRunning) { vuRunning = true; requestAnimationFrame(vu); }
 if (!quiet && normalized !== 'blank') emit('transport', { state: normalized });
}
let lastUserTransportAction = null; // { state, time }
let transportReconcileTimer = null;

function trace(event, data) {
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'RECORD_TRACE',
        payload: {
          ts: Date.now(),
          source: 'boombox',
          event,
          data: data || {}
        }
      }, () => {
        if (chrome.runtime?.lastError) {}
      });
    }
  } catch (e) {}
}

const act=(el,f)=>{el.onclick=f;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();f()}}};
act($('bPlay'),()=>{
  clearTransientStatus();
  // Resume local Web Audio Context on user play interaction
  playbackEnabled = true;
  staticController.ensureContext();
  if (!S.locked) {
    staticController.start(S.vol);
  }
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume();
    }
  } catch (e) {}

  if (transportReconcileTimer) { clearTimeout(transportReconcileTimer); transportReconcileTimer = null; }
  const t_boombox_play_click = Date.now();
  lastUserTransportAction = { state: 'playing', time: t_boombox_play_click };
  trace('CLICK_PLAY', { t_boombox_play_click });
  sendBoomBoxAction('PLAY', { t_boombox_play_click });
});
act($('bPause'),()=>{
  clearTransientStatus();
  if (transportReconcileTimer) { clearTimeout(transportReconcileTimer); transportReconcileTimer = null; }
  playbackEnabled = false;
  staticController.stop();
  const next = S.state === 'playing' ? 'paused' : 'playing';
  lastUserTransportAction = { state: next, time: Date.now() };
  setState(next, true);
  trace('CLICK_PAUSE', { optimisticState: next });
  sendBoomBoxAction(next === 'paused' ? 'PAUSE' : 'PLAY');
});
act($('bStop'),()=>{
  playbackEnabled = false;
  staticController.stop();
  showTransientStatus('stopped');
  if (transportReconcileTimer) { clearTimeout(transportReconcileTimer); transportReconcileTimer = null; }
  lastUserTransportAction = { state: 'stopped', time: Date.now() };
  setState('stopped', true);
  trace('CLICK_STOP', { optimisticState: 'stopped' });
  sendBoomBoxAction('STOP');
});

// knobs
function knob(el,key,base,min,max,onSet,step){
 const rot=()=>el.style.transform='rotate('+(min+S[key]*(max-min)-base)+'deg)';
 const set=v=>{S[key]=clamp(v);onSet&&onSet();rot();};
 let lx,ly,drag=false;
 el.onpointerdown=e=>{drag=true;lx=e.clientX;ly=e.clientY;el.setPointerCapture(e.pointerId);el.style.cursor='grabbing';staticController.ensureContext();};
 el.onpointermove=e=>{if(!drag)return;set(S[key]+((e.clientX-lx)-(e.clientY-ly))/220);lx=e.clientX;ly=e.clientY};
 el.onpointerup=el.onpointercancel=()=>{drag=false;el.style.cursor='grab'};
 el.onwheel=e=>{e.preventDefault();staticController.ensureContext();set(S[key]-Math.sign(e.deltaY)*step)};
 el.onkeydown=e=>{const d={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1}[e.key];if(d){e.preventDefault();staticController.ensureContext();set(S[key]+d*step)}};
 rot();return set;
}
knob($('kVol'),'vol',-163,-140,140,()=>{staticController.setVolume(S.vol);emit('volume',{value:S.vol});sendBoomBoxAction('SET_VOLUME',{volume:Math.round(S.vol*100)})},.03);
knob($('kBal'),'bal',10,-135,135,()=>{const bVal=Number((S.bal*2-1).toFixed(2));emit('balance',{value:bVal});sendBoomBoxAction('SET_BALANCE',{balance:bVal})},.04);
knob($('kTun'),'tun',40,-135,135,tune,.2/20.5);
$('kBal').ondblclick=()=>{S.bal=.5;$('kBal').style.transform='rotate(-10deg)';emit('balance',{value:0});sendBoomBoxAction('SET_BALANCE',{balance:0})};

// optional deck buttons: rewind / fast forward flash when clicked, record latches on/off.
// Set any of these to false to disable that button completely (no click area, no event).
const BUTTONS={rewind:true,forward:true,record:true};
[['rewind',573,'Rewind 10s / Previous','gRew',true],['forward',625,'Fast forward 10s / Next','gFwd',true],['record',677,'Request a song','gRec',false]].forEach(([k,left,label,cls,pulse])=>{
 if(!BUTTONS[k])return;
 const b=document.createElement('div');b.className='hit btn';b.style.left=left+'px';b.tabIndex=0;b.setAttribute('role','button');b.setAttribute('aria-label',label);$('stage').appendChild(b);
 const gs=document.querySelectorAll('.'+cls);
 act(b,()=>{if(pulse){gs.forEach(e=>e.classList.add('on'));setTimeout(()=>gs.forEach(e=>e.classList.remove('on')),600);
   if(k==='rewind'){showTransientStatus('rew');sendBoomBoxAction('REWIND');emit('previous',{});}
   else if(k==='forward'){showTransientStatus('ff');sendBoomBoxAction('FAST_FORWARD');emit('next',{});}}
  else{const on=!gs[0].classList.contains('on');gs.forEach(e=>e.classList.toggle('on',on));emit('record',{on})}})});

// display panel expand/collapse
const pan=$('panel');
function setOpen(o){pan.classList.toggle('collapsed',!o);$('tgl').setAttribute('aria-expanded',o);emit('display',{open:o});try{localStorage.setItem('rfm-open',o?'1':'0')}catch(e){}}
$('tgl').onclick=()=>setOpen(pan.classList.contains('collapsed'));
try{if(localStorage.getItem('rfm-open')==='0')setOpen(false)}catch(e){}

// logo: file pattern <decade>s-white.png / <decade>s-black.png in LOGO_BASE
const LOGO_BASE='logos/';let dark=true,logoDec=S.dec;
// boom box art swaps with the theme: boom-box-white.png / boom-box-black.png in BOX_BASE (falls back to the built-in image if missing)
const BOX_BASE='images/';let boxUrl='';
function setBox(){const u=BOX_BASE+'boom-box-'+(dark?'black':'white')+'.png';if(u===boxUrl)return;boxUrl=u;
 const im=new Image(),r=document.body.style;
 im.onload=()=>{if(u===boxUrl)r.setProperty('--img','url('+u+')')};
 im.onerror=()=>{if(u===boxUrl)r.removeProperty('--img')};
 im.src=u;}
function paintLogo(){const i=$('logo'),f=$('fb');document.body.classList.toggle('dark',dark);document.documentElement.classList.toggle('dark',dark);setBox();if(!logoDec){i.style.display='none';f.style.display='none';i.removeAttribute('src');$('logoBar').style.cursor='default';return}$('logoBar').style.cursor='pointer';
 i.style.display='block';f.style.display='none';
 i.onerror=()=>{i.style.display='none';f.style.display='block';f.textContent='RetroFM \u00B7 '+logoDec+'s'};
 const targetSrc = LOGO_BASE+logoDec+'s-'+(dark?'black':'white')+'.png';
 if (i.getAttribute('src') !== targetSrc) {
   i.src = targetSrc;
 }}
paintLogo();
function setSongYear(y){}
const flip=()=>{if(!logoDec)return;dark=!dark;paintLogo();emit('theme',{dark})};
$('logoBar').onclick=flip;$('logoBar').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();flip()}};
document.addEventListener('retrofm:song',e=>{const d=e.detail||{};if(d.title)setSong(d);if(d.year)setSongYear(d.year)});
window.RetroFM={setSongYear,setSong,setTransport:s=>setState(s,true)};

// tuning: dial = FM frequency, locks onto the selected decade's genre stations
const MIN=87.5,SPAN=20.5;let lastKey='';
// Seven-segment display mapping: A, B, C, D, E, F, G
const SEG_MAP = {
  '0': ['a','b','c','d','e','f'],
  '1': ['b','c'],
  '2': ['a','b','g','e','d'],
  '3': ['a','b','g','c','d'],
  '4': ['f','g','b','c'],
  '5': ['a','f','g','c','d'],
  '6': ['a','f','g','e','c','d'],
  '7': ['a','b','c'],
  '8': ['a','b','c','d','e','f','g'],
  '9': ['a','b','c','d','f','g']
};
function render7SegFreq(fStr){
  let h = '<span class="seg-display" aria-label="' + fStr + ' FM">';
  for (const ch of fStr) {
    if (ch === '.') {
      h += '<span class="seg-dp"><span class="seg-dp-box"></span></span>';
    } else if (SEG_MAP[ch]) {
      const on = new Set(SEG_MAP[ch]);
      h += '<span class="seg-digit">';
      for (const s of ['a','b','c','d','e','f','g']) {
        h += '<span class="seg-bar seg-' + s + (on.has(s) ? ' on' : '') + '"></span>';
      }
      h += '</span>';
    }
  }
  h += '<span class="seg-unit" aria-hidden="true"><span class="seg-unit-fm">FM</span><span class="seg-unit-mhz">MHz</span></span></span>';
  return h;
}
function tune(){
 const f=Math.round((MIN+S.tun*SPAN)*10)/10;S.tun=(f-MIN)/SPAN;
 $('kTun').style.transform='rotate('+(-135+S.tun*270-40)+'deg)';
 const x=fx(MIN+S.tun*SPAN);$('tn').setAttribute('x1',x);$('tn').setAttribute('x2',x);
 let best=null;
 const stations=ST[S.dec]||[];
 stations.forEach(s=>{const d=Math.abs(s[1]-f);if(d<0.05)best=s});
 $('year').innerHTML=render7SegFreq(f.toFixed(1));
 S.locked=!!best;
 const sdotEl=$('sdot');if(sdotEl)sdotEl.style.display=best?'':'none';
 const giEl=$('gi');if(giEl)giEl.textContent=best?'':'Between stations';
 updateGenrePills();
 const key=S.dec+'|'+(best?best[0]:'');
 if(best){const hg=$('hGen');if(hg)hg.textContent=best[0].toUpperCase();if(gl===stations)gi=gl.indexOf(best)}
 if(!best){
   setSeekingState(false);
   if(playbackEnabled) staticController.start(S.vol);
   song=null;
   playbackProgress.currentTime = 0;
   playbackProgress.duration = 0;
   playbackProgress.videoId = null;
   renderSong();
   updateStatusDisplay();
 }else{
   staticController.stop();
   setSeekingState(true);
   playbackEnabled = true;
   updateStatusDisplay();
 }
 if(key!==lastKey){
   lastKey=key;
   marks();
   if(pan.classList.contains('live')){
     emit('tune',{decade:S.dec,frequency:f,genre:best?best[0]:null,locked:!!best});
     sendBoomBoxAction('TUNE',{decade:S.dec,frequency:f,genre:best?best[0]:null,locked:!!best,autoPlay:best ? true : playbackEnabled});
   }
 }
}
function paintChips(d){
 const chipsEl=$('chips');if(!chipsEl)return;chipsEl.innerHTML='';
 [...(ST[d]||[])].sort((a,b)=>a[1]-b[1]).forEach(s=>{const b=document.createElement('button');b.className='chip';b.dataset.g=s[0];b.textContent=s[0];b.title=s[1].toFixed(1)+' FM';
  b.onclick=()=>{staticController.ensureContext();S.tun=(s[1]-MIN)/SPAN;tune()};chipsEl.appendChild(b)});
 updateGenrePills();
}
function setDec(d){S.dec=d;lastKey='';
 document.querySelectorAll('.dec').forEach(b=>b.classList.toggle('sel',+b.textContent===d));
 logoDec=d;paintLogo();paintChips(d);
 tune();}
// FM scale drawn to match the dial: x position for a frequency (88 to 108 MHz)
const fx=f=>330+(f-87.5)*27.3;
(function(){let h='';for(let f=88;f<=108;f++){const M=f%4===0,x=fx(f).toFixed(1);
 h+='<line x1="'+x+'" x2="'+x+'" y1="'+(M?158:163)+'" y2="168" stroke="#3d3a37" stroke-width="'+(M?1.8:1.1)+'"/>';
 if(M)h+='<text x="'+x+'" y="153" text-anchor="middle" font-size="15" fill="#3d3a37" font-family="system-ui,sans-serif">'+f+'</text>'}
 $('scale').innerHTML=h})();
function marks(){$('stn').innerHTML=ST[S.dec].map(s=>'<circle cx="'+fx(s[1]).toFixed(1)+'" cy="180" r="3.4" fill="#c8741a"/>').join('')}
// Live mode: real songs received from RetroFM session
const DEMO=false;
// song info on the display: title and artist alternate with 1.2s fade and 3s hold
// songDisplayMode: 'song_info' (1) -> 'elapsed_time' (2) -> 'hidden' (3)
let songDisplayMode = 'song_info';
try {
  const savedMode = localStorage.getItem('rfm-song-display-mode');
  if (savedMode === 'song_info' || savedMode === 'elapsed_time' || savedMode === 'hidden') {
    songDisplayMode = savedMode;
  }
} catch (e) {}

let playbackProgress = { currentTime: 0, duration: 0, videoId: null };

function formatPlaybackTime(sec) {
  if (typeof sec !== 'number' || isNaN(sec) || sec < 0) return null;
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updateGenrePills() {
  const isPlaying = S.state === 'playing' && isYtPlaybackActive;
  const stations = ST[S.dec] || [];
  const f = Math.round((MIN + S.tun * SPAN) * 10) / 10;
  let best = null;
  stations.forEach(s => {
    if (Math.abs(s[1] - f) < 0.05) best = s;
  });
  document.querySelectorAll('.chip').forEach(c => {
    const isSelected = !!best && c.dataset.g === best[0];
    c.classList.toggle('sel', isSelected && isPlaying);
  });
}

let song=null,fadeOn=true,phase=0,sTimer=0,sFadeTimer=0,appConnected=false;

function clearSongTimers(){
  if(sTimer){clearTimeout(sTimer);sTimer=0;}
  if(sFadeTimer){clearTimeout(sFadeTimer);sFadeTimer=0;}
}

function renderSong(){
  const el=$('sg');
  const sdotEl=$('sdot');
  clearSongTimers();
  el.className='';
  el.style.opacity='1';
  el.title='';

  if(sdotEl){
    sdotEl.classList.remove('mode-hidden');
    if(songDisplayMode==='song_info'){
      sdotEl.textContent='\u266B';
      sdotEl.title='Song Information (click for elapsed time)';
      sdotEl.setAttribute('aria-label','Song information mode: showing title and artist');
    }else if(songDisplayMode==='elapsed_time'){
      sdotEl.textContent='\u23F1';
      sdotEl.title='Elapsed Time (click to hide)';
      sdotEl.setAttribute('aria-label','Elapsed time mode: showing playback position');
    }else{
      sdotEl.textContent='\u2022';
      sdotEl.classList.add('mode-hidden');
      sdotEl.title='Display Hidden (click for song information)';
      sdotEl.setAttribute('aria-label','Display hidden mode: click to show song information');
    }
  }

  if(songDisplayMode==='hidden'){
    el.textContent='';
    return;
  }

  if(!fadeOn){el.textContent='';return;}
  if(!appConnected){el.textContent='Offline';el.className='dim';return;}
  if(!S.locked){el.textContent='';el.title='';return;}

  if(!song || !hasFirstSongStartedPlaying){
    el.textContent='';
    return;
  }

  if(songDisplayMode==='elapsed_time'){
    if(playbackProgress.videoId && song.videoId && playbackProgress.videoId !== song.videoId){
      el.textContent='';
      el.title='';
      return;
    }
    const curFmt = formatPlaybackTime(playbackProgress.currentTime) || '00:00';
    const durFmt = formatPlaybackTime(playbackProgress.duration);
    if(durFmt){
      el.textContent = curFmt + ' / ' + durFmt;
    }else{
      el.textContent = curFmt;
    }
    el.title = 'Elapsed playback time: ' + el.textContent;
    return;
  }

  el.title=song.title+(song.artist?' by '+song.artist:'');
  if(!song.artist){
    el.textContent=song.title;
    return;
  }

  // Two screens: phase 0 = Song Title, phase 1 = Artist
  phase=0;
  el.textContent=song.title;
  if(S.state==='playing' || S.state==='paused' || S.state==='stopped'){
    scheduleSongFade();
  }
}

function scheduleSongFade(){
  clearSongTimers();
  if(songDisplayMode!=='song_info')return;
  if(!song||!song.artist||!fadeOn||!appConnected||!S.locked||(S.state!=='playing'&&S.state!=='paused'&&S.state!=='stopped'))return;

  // Hold current screen for 3000ms
  sTimer=setTimeout(()=>{
    const el=$('sg');
    if(!el)return;
    // Fade out (CSS transition: 1.2s)
    el.style.opacity='0';
    sFadeTimer=setTimeout(()=>{
      if(songDisplayMode!=='song_info')return;
      if(!song||!fadeOn||!appConnected||!S.locked||(S.state!=='playing'&&S.state!=='paused'&&S.state!=='stopped'))return;
      // Switch screen: phase 0 was Title -> next is Artist (1); phase 1 was Artist -> next is Title (0)
      phase=phase===0?1:0;
      el.textContent=phase===1?song.artist:song.title;
      // Fade in
      el.style.opacity='1';
      // Schedule next rotation
      scheduleSongFade();
    },1200);
  },3000);
}

function cleanTitle(rawTitle, artist) {
  if (!rawTitle) return '';
  let t = String(rawTitle).trim();
  // Strip release year in parentheses e.g. (1985) or (1985 Remastered)
  t = t.replace(/\s*\(\s*(?:19\d{2}|20\d{2})\s*(?:remaster(?:ed)?|mix|edit|version)?\s*\)/gi, '');
  // Also strip [1985] or [1985 Remastered]
  t = t.replace(/\s*\[\s*(?:19\d{2}|20\d{2})\s*(?:remaster(?:ed)?|mix|edit|version)?\s*\]/gi, '');

  // Strip leading artist if present at start e.g. "a-ha - Take on Me" or "a-ha — Take on Me"
  if (artist && artist.trim()) {
    const aEsc = artist.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leadArtistRegex = new RegExp('^' + aEsc + '\\s*[-:—–~]\\s*', 'i');
    t = t.replace(leadArtistRegex, '');
  } else {
    // If no artist provided, check if format is "Artist - Title" (allowing hyphens inside artist name by splitting on first space-dash-space or em-dash)
    const match = t.match(/^(.*?)\s+(?:[-—–~]|:)\s+(.*)$/);
    if (match) {
      t = match[2];
    }
  }
  return t.trim();
}

function cleanArtist(rawArtist, rawTitle) {
  const cleanStr = (s) => (s && String(s).trim() !== 'undefined' && String(s).trim() !== 'null') ? String(s).trim() : '';
  const rA = cleanStr(rawArtist);
  let embeddedArtist = '';
  if (rawTitle) {
    const match = String(rawTitle).trim().match(/^(.*?)\s+(?:[-—–~]|:)\s+(.*)$/);
    if (match && match[1].trim()) {
      embeddedArtist = match[1].trim();
    }
  }

  // If rawTitle contains "EmbeddedArtist - Title" and rawArtist differs from embeddedArtist:
  if (embeddedArtist && rA) {
    const rALower = rA.toLowerCase();
    const embLower = embeddedArtist.toLowerCase();
    if (rALower !== embLower && !embLower.includes(rALower) && !rALower.includes(embLower)) {
      return embeddedArtist;
    }
  }

  if (rA) {
    return rA;
  }
  return embeddedArtist;
}

function setSong(d){
  let nextSong = null;
  if(d&&d.title){
    const rawTitle=String(d.title).trim();
    const rawArtist=d.artist?String(d.artist).trim():(song&&song.videoId&&d.videoId&&song.videoId===d.videoId?song.artist:'');
    if(rawTitle&&rawTitle!=='undefined'&&rawTitle!=='null'){
      const artist = cleanArtist(rawArtist, rawTitle);
      const title = cleanTitle(rawTitle, artist);
      const vid = d.videoId || (song ? song.videoId : null);
      nextSong={title: title || rawTitle, artist, videoId: d.videoId || null};
      if (!nextSong.videoId && vid) nextSong.videoId = vid;
    }
  }
  if (!nextSong && !song) return;
  if (nextSong && song) {
    const isSameVideo = nextSong.videoId && song.videoId && nextSong.videoId === song.videoId;
    const isSameMetadata = nextSong.title.toLowerCase() === song.title.toLowerCase() &&
      (nextSong.artist.toLowerCase() === song.artist.toLowerCase() || (!nextSong.artist && song.artist));
    if (isSameVideo || isSameMetadata) {
      if (!song.artist && nextSong.artist) {
        song.artist = nextSong.artist;
      }
      if (!song.videoId && nextSong.videoId) {
        song.videoId = nextSong.videoId;
      }
      return;
    }
  }
  song = nextSong;
  renderSong();
}
window.addEventListener('beforeunload',()=>{clearSongTimers();clearTransientStatus();});
window.addEventListener('beforeunload',()=>{staticController.dispose();});
$('sdot').onclick=()=>{
  if(songDisplayMode==='song_info'){
    songDisplayMode='elapsed_time';
  }else if(songDisplayMode==='elapsed_time'){
    songDisplayMode='hidden';
  }else{
    songDisplayMode='song_info';
  }
  try{localStorage.setItem('rfm-song-display-mode',songDisplayMode)}catch(e){}
  renderSong();
};

// entry board: type a date, pick a genre, press Enter to tune in
const FN=20,MON=['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
const dIn=$('dIn'),fD=$('fDate'),fG=$('fGen'),hint=$('bHint'),brd=$('board');
let D=null,gi=0,gl=[],step='date';
function cells(el){if(!el.children.length)for(let i=0;i<FN;i++){const c=document.createElement('span');c.className='fl';c.textContent=' ';c.dataset.c=' ';el.appendChild(c)}return el.children}
function flap(el,txt,ph){el.classList.toggle('ph',!!ph);const cs=cells(el);
 for(let i=0;i<FN;i++){const c=cs[i],ch=(txt[i]||' ').toUpperCase();
  if(c.dataset.c!==ch){c.dataset.c=ch;c.classList.remove('f');void c.offsetWidth;c.style.animationDelay=i*16+'ms';c.classList.add('f');setTimeout(()=>{c.textContent=ch},i*16+130)}}}
function caret(){const n=dIn.value.length;[...cells(fD)].forEach((c,i)=>c.classList.toggle('cur',i===Math.min(n,FN-1)))}
function parseDate(s){s=s.trim();let m,d;
 if(m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))d=new Date(+m[1],m[2]-1,+m[3]);
 else{if(!/\d{4}/.test(s)||s.split(/[\s,\/\-]+/).filter(Boolean).length<3)return null;const t=Date.parse(s);if(isNaN(t))return null;d=new Date(t)}
 if(d.getFullYear()<1960||d>new Date())return null;return d}
const MIDX=s=>MON.findIndex(m=>m.toLowerCase().startsWith(s.toLowerCase()));
// month spell-check: a unique prefix (Jul, Sept) or a close misspelling (Marrch, Febuary) resolves to the month
const lev=(a,b)=>{const d=[...Array(b.length+1).keys()];for(let i=1;i<=a.length;i++){let p=d[0];d[0]=i;for(let j=1;j<=b.length;j++){const t=d[j];d[j]=Math.min(d[j]+1,d[j-1]+1,p+(a[i-1]===b[j-1]?0:1));p=t}}return d[b.length]};
function fixMonth(w){const s=w.toLowerCase();if(s.length<3)return -1;
 const pre=MON.map((m,i)=>m.toLowerCase().startsWith(s)?i:-1).filter(i=>i>=0);if(pre.length===1)return pre[0];
 let best=-1,bd=9,tie=false;MON.forEach((m,i)=>{const d=lev(s,m.toLowerCase());if(d<bd){bd=d;best=i;tie=false}else if(d===bd)tie=true});
 return !tie&&bd<=Math.min(2,Math.max(1,Math.floor(s.length/3)))?best:-1}
const MDAYS=[31,29,31,30,31,30,31,31,30,31,30,31];
function problem(v){v=v.trim();if(!v)return'';
 const m=v.match(/^([A-Za-z]+)\.?(?:\s+(\d{1,2})(?:\s*,?\s*(\d{0,4}))?)?\s*$/);
 if(!m)return /^\d/.test(v)?'':'Use a format like July 4, 1978';
 const mi=MIDX(m[1]);if(mi<0)return m[2]===undefined?'':'Start with a month, like July';
 const nm=MON[mi][0]+MON[mi].slice(1).toLowerCase();
 if(m[2]&&(+m[2]<1||+m[2]>MDAYS[mi]))return nm+' has at most '+MDAYS[mi]+' days';
 if(m[3]&&m[3].length===4){const y=+m[3];if(y<1960)return'The dial starts in 1960';if(y>new Date().getFullYear())return'That year hasn\'t happened yet'}
 return''}
 function refresh(q){const v=dIn.value;D=parseDate(v);if(D&&!(v.match(/\d+/g)||[]).map(Number).includes(D.getDate()))D=null;if(!D)step='date';
  if(D){flap(fD,MON[D.getMonth()]+' '+D.getDate()+', '+D.getFullYear());
   const dec=Math.floor(D.getFullYear()/10)*10;if(gl!==ST[dec]){gl=ST[dec];gi=0}
   if(dec>=1960&&dec<=2020&&logoDec!==dec){logoDec=dec;paintLogo();}
   flap(fG,gl[gi][0]);hint.textContent=step==='genre'?'\u2191\u2193 CHOOSE GENRE \u00B7 ENTER TO TUNE IN \u00B7 TAB: DATE':'ENTER OR TAB TO CHOOSE A GENRE';hint.className=''}
  else{flap(fD,v||'TYPE A DATE',!v);gl=[];flap(fG,'GENRE',1);
   if(logoDec!==S.dec){logoDec=S.dec;paintLogo();}
   const p=q?'':problem(v);hint.textContent=p||(v.length>5?'Try July 4, 1978 \u00B7 1960 to today':'e.g. July 4, 1978');hint.className=p?'err':''}
  brd.dataset.s=step;caret()}
function cyc(d){if(!D)return;gi=(gi+d+gl.length)%gl.length;flap(fG,gl[gi][0])}
function goLive(){const y=D.getFullYear(),dec=Math.floor(y/10)*10,g=gl[gi];
 pan.classList.replace('entry','live');
 $('hDate').textContent=MON[D.getMonth()]+' '+D.getDate()+', '+y;const hg=$('hGen');if(hg)hg.textContent=g[0].toUpperCase();
 S.tun=(g[1]-MIN)/SPAN;setDec(dec);
 const dateStr=y+'-'+String(D.getMonth()+1).padStart(2,'0')+'-'+String(D.getDate()).padStart(2,'0');
 emit('select',{date:dateStr,year:y,decade:dec,genre:g[0],frequency:g[1]});
 sendBoomBoxAction('SELECT_DATE_GENRE',{date:dateStr,year:y,decade:dec,genre:g[0],frequency:g[1]});}
dIn.oninput=e=>{step='date';let v=dIn.value.replace(/[^A-Za-z0-9 ,\/\-]/g,'').replace(/^\s+/,'').replace(/\s{2,}/g,' ').replace(/,\s*,/g,', ');
 if(e.inputType&&e.inputType.startsWith('insert')){
  v=v.replace(/^([A-Za-z]+)(?=\d)/,'$1 ');
  const mm=v.match(/^([A-Za-z]+)(?=[\s\d.,\/\-])/);if(mm){const k=fixMonth(mm[1]);if(k>=0){const nm=MON[k][0]+MON[k].slice(1).toLowerCase();if(mm[1]!==nm)v=nm+v.slice(mm[1].length)}}
  if(/^[A-Za-z]+$/.test(v)&&MON.some(m=>m.toLowerCase()===v.toLowerCase()))v+=' ';
  else if(/^[A-Za-z]+\s\d$/.test(v)&&+v.slice(-1)>3)v+=', ';
  else if(/^[A-Za-z]+\s[123]\d$/.test(v)&&+v.slice(-2)<=31)v+=', '}
 if(v!==dIn.value)dIn.value=v;refresh(!!(e.inputType&&e.inputType.startsWith('delete')))};
document.addEventListener('keydown',e=>{if(!pan.classList.contains('entry')||e.ctrlKey||e.metaKey||e.altKey)return;
 if(e.key==='Tab'){e.preventDefault();if(step==='genre'){step='date';refresh();dIn.focus()}else if(D){step='genre';refresh()}else{hint.textContent='Enter a date from 1960 to today';hint.className='err'}}
 else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();if(step==='genre')cyc(e.key==='ArrowUp'?-1:1)}
 else if(e.key==='Enter'){e.preventDefault();if(!D){hint.textContent='Enter a date from 1960 to today';hint.className='err'}else if(step==='date'){step='genre';refresh()}else goLive()}
 else if(e.key==='Escape'){if(step==='genre'){step='date';refresh()}else if(dIn.value){dIn.value='';refresh(true)}}
 else if((e.key.length===1||e.key==='Backspace'||e.key==='Delete')&&document.activeElement!==dIn){step='date';dIn.focus()}});
const endCaret=()=>{const n=dIn.value.length;try{dIn.setSelectionRange(n,n)}catch(e){}};
dIn.onfocus=()=>{brd.classList.add('foc');endCaret()};dIn.onblur=()=>brd.classList.remove('foc');
dIn.addEventListener('keydown',e=>{if(!e.metaKey&&!e.ctrlKey&&dIn.selectionStart===dIn.selectionEnd)endCaret()});
dIn.addEventListener('mouseup',()=>setTimeout(endCaret,0));
fG.onclick=()=>{if(D){if(step==='genre')cyc(1);else{step='genre';refresh()}}else{hint.textContent='Enter a date first';hint.className='err'}dIn.focus()};
dIn.onclick=()=>{if(step==='genre'){step='date';refresh()}};
$('bDate').onclick=()=>{step='date';refresh();dIn.focus()};
$('bGen').onclick=()=>{if(D){step='genre';refresh()}dIn.focus()};
const back=s=>{pan.classList.replace('live','entry');step=s;emit('update',{});refresh();dIn.focus()};
$('hDate').onclick=()=>back('date');if($('hGen'))$('hGen').onclick=()=>back('genre');
tune();refresh();dIn.focus();

// VU meters (simulated: music plays in YouTube tab; needles scale directly with master volume)
let env=0,nl=0,nr=0,beat=.5,vuRunning=false,isYtPlaybackActive=false;
function vu(){
 const isPlaying = S.state === 'playing' && isYtPlaybackActive;
 if(isPlaying){
  if(Math.random()<.14) beat=.35+Math.random()*.55;
  env += (beat-env)*.3;
 } else {
  env *= .85;
 }

 // Master volume scaling: at vol=0, needles stay completely at rest
 const v = Math.max(0, S.vol);
 const gl = S.bal<=.5 ? 1 : 2*(1-S.bal);
 const gr = S.bal>=.5 ? 1 : 2*S.bal;

 const tl = isPlaying ? env * gl * v * (.88 + Math.random()*.24) : 0;
 const tr = isPlaying ? env * gr * v * (.88 + Math.random()*.24) : 0;

 nl += (tl-nl) * (tl > nl ? .35 : .12);
 nr += (tr-nr) * (tr > nr ? .35 : .12);

 aim('nl', 833, nl);
 aim('nr', 957, nr);

 // Stop RAF loop once needles have settled back to zero if not playing
 if(isPlaying || nl > 0.005 || nr > 0.005 || env > 0.005){
  vuRunning = true;
  requestAnimationFrame(vu);
 } else {
  nl = 0; nr = 0; env = 0;
  aim('nl', 833, 0);
  aim('nr', 957, 0);
  vuRunning = false;
 }
}
function aim(id,px,l){const a=(-47+clamp(l)*94)*Math.PI/180,n=$(id);n.setAttribute('x2',px+Math.sin(a)*58);n.setAttribute('y2',352-Math.cos(a)*58)}
vuRunning = true;
requestAnimationFrame(vu);

$('copy').onclick=e=>e.stopPropagation();

// --- Chrome Extension Integration Bridge ---
function setVisualVolume(fraction) {
  if (typeof fraction !== 'number' || isNaN(fraction)) return;
  S.vol = clamp(fraction);
  staticController.setVolume(S.vol);
  $('kVol').style.transform = 'rotate(' + (-140 + S.vol * 280 - (-163)) + 'deg)';
}

function setVisualTransport(incomingState) {
  if (incomingState !== 'playing' && incomingState !== 'paused' && incomingState !== 'stopped') return;

  const prevState = S.state;

  // If user clicked a transport button recently, allow up to ~1.5s for app/YouTube to synchronize
  if (lastUserTransportAction) {
    const elapsed = Date.now() - lastUserTransportAction.time;
    if (incomingState === lastUserTransportAction.state) {
      // Dispatched state agrees with user action: clear guard
      lastUserTransportAction = null;
      if (transportReconcileTimer) { clearTimeout(transportReconcileTimer); transportReconcileTimer = null; }
      const changed = S.state !== incomingState;
      setState(incomingState, true);
      trace('RECONCILE_AGREED', { incomingState, prevState, changedUI: changed, elapsed });
      return;
    }

    if (elapsed < 1500) {
      // Incoming state still disagrees and within the 1.5s window: retain local state and schedule correction if still disagreeing after timeout
      trace('RECONCILE_DEFERRED', { incomingState, pendingUserAction: lastUserTransportAction.state, elapsed });
      if (!transportReconcileTimer) {
        const remaining = Math.max(50, 1500 - elapsed);
        transportReconcileTimer = setTimeout(() => {
          transportReconcileTimer = null;
          lastUserTransportAction = null;
          const changed = S.state !== incomingState;
          setState(incomingState, true);
          trace('RECONCILE_TIMEOUT_CORRECTED', { incomingState, prevState: S.state, changedUI: changed });
        }, remaining);
      }
      return;
    }

    // Window exceeded (>1.5s): reconcile to incoming authoritative state
    lastUserTransportAction = null;
    if (transportReconcileTimer) { clearTimeout(transportReconcileTimer); transportReconcileTimer = null; }
  }

  const changed = S.state !== incomingState;
  setState(incomingState, true);
  trace('APPLY_TRANSPORT_STATE', { incomingState, prevState, changedUI: changed });
}

function sendBoomBoxAction(action, data) {
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'BOOMBOX_ACTION',
        payload: { action, ...(data || {}) }
      }, () => {
        if (chrome.runtime?.lastError) {
          // Extension service worker might be waking up or app disconnected
        }
      });
    }
  } catch (err) {
    console.warn('[BoomBox] Action send error:', err);
  }
}

function applyRadioState(state) {
  if (!state || typeof state !== 'object') return;
  appConnected = state.appConnected !== false;

  if (!appConnected) {
    updateStatusDisplay();
    const giEl = $('gi'); if (giEl) giEl.textContent = 'Open RetroFM app to broadcast';
    song = null;
    renderSong();
    return;
  }

  // Authoritative decade update for footer logo
  if (typeof state.decade === 'number' && state.decade >= 1960 && state.decade <= 2020) {
    if ((logoDec !== state.decade || S.dec !== state.decade) && !isYtPlaybackActive) {
      logoDec = state.decade;
      S.dec = state.decade;
      document.querySelectorAll('.dec').forEach(b => b.classList.toggle('sel', +b.textContent === state.decade));
      paintLogo();
    }
  }

  // Authoritative tracking of startup readiness (YouTube tab loaded first video)
  if (state.isStartupReady || (state.videoId && state.videoId !== 'Unknown' && state.videoId !== 'Unknown Video')) {
    isStartupReady = true;
    markStartupReady();
  }

  // Authoritative tracking of first song playback status suppression
  if (typeof state.hasFirstSongStartedPlaying === 'boolean') {
    hasFirstSongStartedPlaying = state.hasFirstSongStartedPlaying;
  }

  // Dynamic station definitions
  if (Array.isArray(state.stations) && state.stations.length > 0) {
    const normalized = state.stations.map(s => {
      if (Array.isArray(s)) return s;
      return [s.genre || s.name, typeof s.frequency === 'number' ? s.frequency : s.freq];
    });
    const currentStations = ST[S.dec] || [];
    const hasStationsChanged = currentStations.length !== normalized.length ||
      normalized.some((s, idx) => !currentStations[idx] || currentStations[idx][0] !== s[0] || Math.abs(currentStations[idx][1] - s[1]) > 0.01);

    if (hasStationsChanged) {
      ST[S.dec] = normalized;
      paintChips(S.dec);
      marks();
    } else {
      updateGenrePills();
    }
  }

  // 1. Playback status
  if (state.playbackStatus) {
    if (state.playbackStatus === 'blank') {
      setSeekingState(false);
      if (!lastUserTransportAction || lastUserTransportAction.state !== 'playing') {
        isYtPlaybackActive = false;
        setState('blank', true);
      }
    } else if (state.playbackStatus === 'seek' || state.playbackStatus === 'seeking') {
      setSeekingState(true);
    } else {
      isYtPlaybackActive = state.playbackStatus === 'playing';
      if (state.playbackStatus === 'playing') {
        setSeekingState(false);
        playbackEnabled = true;
      } else if (state.playbackStatus === 'stopped') {
        setSeekingState(false);
        playbackEnabled = false;
        staticController.stop();
      } else if (state.playbackStatus === 'paused') {
        if (!isSeeking) {
          setVisualTransport('paused');
        }
        return;
      }
      setVisualTransport(state.playbackStatus);
    }
  }

  // 2. Volume (visual only, no command feedback loop)
  if (typeof state.masterVolume === 'number') {
    setVisualVolume(state.masterVolume / 100);
  }

  // 3. Current Song
  if (state.currentSong && state.currentSong.title) {
    if (state.currentSong.videoId && state.currentSong.videoId !== playbackProgress.videoId) {
      playbackProgress.videoId = state.currentSong.videoId;
      playbackProgress.currentTime = typeof state.currentSong.currentTime === 'number' ? state.currentSong.currentTime : 0;
    } else if (typeof state.currentSong.currentTime === 'number' && state.currentSong.currentTime > 0) {
      playbackProgress.currentTime = state.currentSong.currentTime;
    }
    if (typeof state.currentSong.durationSec === 'number' && state.currentSong.durationSec > 0) {
      playbackProgress.duration = state.currentSong.durationSec;
    } else if (typeof state.currentSong.duration === 'string') {
      const parts = state.currentSong.duration.split(':').map(Number);
      if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        playbackProgress.duration = parts[0] * 60 + parts[1];
      } else if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
        playbackProgress.duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
      }
    }
    setSong(state.currentSong);
  } else if (state.clearSong) {
    song = null;
    renderSong();
  } else if (!song) {
    renderSong();
  }
}

function requestRadioState() {
  try {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'GET_RADIO_STATE' }, (response) => {
        if (!chrome.runtime?.lastError && response?.success && response?.data) {
          applyRadioState(response.data);
        } else {
          appConnected = false;
          updateStatusDisplay();
          const giEl = $('gi'); if (giEl) giEl.textContent = 'Open RetroFM app to broadcast';
          renderSong();
        }
      });
    }
  } catch (e) {}
}

if (typeof chrome !== 'undefined' && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'RADIO_STATE') {
      applyRadioState(message.payload);
      sendResponse({ received: true });
    } else if (message && message.type === 'YT_STATE_CHANGED' && message.payload) {
      const rawState = message.payload.state;
      const isPlaying = rawState === 1;
      const vid = message.payload.videoId;
      const isJingle = vid === '3Wk2FzsxK4k' || !hasFirstSongStartedPlaying;
      if (vid) {
        isStartupReady = true;
        markStartupReady();
      }
      if (rawState === 1 && vid && vid !== '3Wk2FzsxK4k') {
        hasFirstSongStartedPlaying = true;
      }
      if (rawState === 1) {
        playbackEnabled = true;
        setSeekingState(false);
        setVisualTransport('playing');
      } else if (rawState === 2) {
        if (!isSeeking) {
          setVisualTransport('paused');
        }
      } else if (rawState === 0) {
        setSeekingState(false);
      }
      if (rawState === 0) {
        // When startup jingle ends naturally, stop playback and reels until user clicks PLAY
        if (isJingle) {
          isYtPlaybackActive = false;
          setVisualTransport('stopped');
        } else if (S.state !== 'playing') {
          setVisualTransport('stopped');
        }
      }
      if (rawState === 0 && isJingle) {
        playbackEnabled = false;
      } else if (rawState === 3) {
        // Buffering / loading
        setSeekingState(true);
      }

      // Update actual playback progress from YouTube
      if (vid && vid !== playbackProgress.videoId) {
        playbackProgress.videoId = vid;
        playbackProgress.currentTime = 0;
      }
      if (typeof message.payload.currentTime === 'number') {
        playbackProgress.currentTime = message.payload.currentTime;
      }
      if (typeof message.payload.duration === 'number' && message.payload.duration > 0) {
        playbackProgress.duration = message.payload.duration;
      }

      trace('YT_STATE_CHANGED_RECV', { rawState, state: S.state, title: message.payload.title });
      if (songDisplayMode === 'elapsed_time') {
        const curFmt = formatPlaybackTime(playbackProgress.currentTime) || '00:00';
        const durFmt = formatPlaybackTime(playbackProgress.duration);
        const targetText = durFmt ? `${curFmt} / ${durFmt}` : curFmt;
        const el = $('sg');
        if (el && el.textContent !== targetText) {
          el.textContent = targetText;
          el.title = 'Elapsed playback time: ' + targetText;
        }
      } else if (!song && message.payload.title && hasFirstSongStartedPlaying) {
        setSong({ title: message.payload.title });
      }
      sendResponse({ received: true });
    }
  });
}

// Request initial state on load and announce Boom Box session startup / refresh
sendBoomBoxAction('BOOMBOX_RELOADED');
requestRadioState();
// Check health every 6 seconds if disconnected
setInterval(() => {
  if (!appConnected) {
    requestRadioState();
  }
}, 6000);

function markStartupReady() {
  isStartupReady = true;
  const modal = $('rfmModal');
  const btn = $('rfmStartBtn');
  if (modal && btn) {
    if (modal.classList.contains('hidden')) return;
    const box = modal.firstElementChild;
    if (box) box.classList.add('ready');
    btn.classList.add('ready');
    if (btn.textContent !== 'STARTING...') {
      btn.disabled = false;
    }
    trace('START_RETRO_FM_READY');
  }
}

// START RETRO FM modal & handoff controller
(function setupStartModal() {
  const modal = $('rfmModal');
  const btn = $('rfmStartBtn');
  const appEl = $('app');
  if (!modal || !btn) return;

  let handoffStarted = false;

  // The button starts disabled and visually black (powered off) until YouTube is ready
  if (isStartupReady) {
    markStartupReady();
  } else {
    btn.disabled = true;
  }

  function dismissModal() {
    modal.classList.add('hidden');
    if (appEl) appEl.classList.remove('rfm-dimmed');
  }

  btn.addEventListener('click', async () => {
    if (!isStartupReady || btn.disabled || handoffStarted) return;
    handoffStarted = true;
    playbackEnabled = true;
    btn.disabled = true;
    btn.textContent = 'STARTING...';
    trace('START_RETRO_FM_CLICKED');

    let finished = false;
    const safetyTimer = setTimeout(() => {
      if (!finished) {
        finished = true;
        dismissModal();
      }
    }, 3000);

    try {
      if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'START_RETRO_FM_HANDOFF' }, (res) => {
          if (!finished) {
            finished = true;
            clearTimeout(safetyTimer);
            dismissModal();
          }
        });
      } else {
        finished = true;
        clearTimeout(safetyTimer);
        dismissModal();
      }
    } catch (e) {
      if (!finished) {
        finished = true;
        clearTimeout(safetyTimer);
        dismissModal();
      }
    }
  });
})();




