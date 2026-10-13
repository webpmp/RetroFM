const $=id=>document.getElementById(id);
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

const S={state:'stopped',vol:.7,bal:.5,tun:(98.7-87.5)/20.5,dec:1970};
const ST={
1960:[['Top 40/Pop',95.1],['Motown',101.5],['Soul',107.1],['R&B',93.5],['Freeform/Underground',99.5],['Folk Rock',102.7],['Psychedelic Rock',104.1]],
1970:[['AOR',95.5],['Disco',98.7],['Progressive Rock',92.3],['Soft Rock',103.5],['Funk',107.5],['Punk Rock',91.1],['Outlaw Country',97.1]],
1980:[['New Wave',90.7],['Synth-Pop',93.1],['Hair Metal',105.5],['Hip-Hop',89.9],['CHR',101.9],['Urban Contemporary',97.9],['College Rock',88.9]],
1990:[['Grunge',99.9],['Alternative Rock',106.7],['Gangsta Rap',92.7],['Contemporary R&B',105.1],['Teen Pop',100.3],['Eurodance',96.3],['Country Pop',94.7]],
2000:[['Nu-Metal',93.7],['Post-Grunge',107.3],['Emo',91.3],['Crunk',106.1],['Electropop',102.3],['Indie Rock',90.3],['Reggaeton',96.7]],
2010:[['EDM',101.1],['Trap',104.5],['Indie Pop',91.9],['Mumble Rap',99.1],['Synthwave',89.3],['Afrobeats',105.9]],
2020:[['Bedroom Pop',88.1],['Hyperpop',90.9],['Amapiano',103.9],['Drift Phonk',95.9],['Regional Mexican',102.9],['Lofi Hip-Hop',88.5]]};
// transport
function setState(s,quiet){S.state=s;
 $('bPlay').classList.toggle('on',s==='playing');$('bPause').classList.toggle('on',s==='paused');
 $('gPlay').classList.toggle('on',s==='playing');document.querySelectorAll('.gp').forEach(e=>e.classList.toggle('on',s==='paused'));
 if(s==='stopped'){$('gStop').classList.add('on');setTimeout(()=>$('gStop').classList.remove('on'),700)}else $('gStop').classList.remove('on');
 $('stage').classList.toggle('playing',s==='playing');
 $('st').textContent=s==='playing'?'\u25B6 PLAYING':s==='paused'?'\u275A\u275A PAUSED':'\u25A0 STOPPED';
 if(!quiet)emit('transport',{state:s});}
const act=(el,f)=>{el.onclick=f;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();f()}}};
act($('bPlay'),()=>setState('playing'));
act($('bPause'),()=>{if(S.state==='playing')setState('paused');else if(S.state==='paused')setState('playing')});
act($('bStop'),()=>setState('stopped'));

// knobs
function knob(el,key,base,min,max,onSet,step){
 const rot=()=>el.style.transform='rotate('+(min+S[key]*(max-min)-base)+'deg)';
 const set=v=>{S[key]=clamp(v);onSet&&onSet();rot();};
 let lx,ly,drag=false;
 el.onpointerdown=e=>{drag=true;lx=e.clientX;ly=e.clientY;el.setPointerCapture(e.pointerId);el.style.cursor='grabbing'};
 el.onpointermove=e=>{if(!drag)return;set(S[key]+((e.clientX-lx)-(e.clientY-ly))/220);lx=e.clientX;ly=e.clientY};
 el.onpointerup=el.onpointercancel=()=>{drag=false;el.style.cursor='grab'};
 el.onwheel=e=>{e.preventDefault();set(S[key]-Math.sign(e.deltaY)*step)};
 el.onkeydown=e=>{const d={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1}[e.key];if(d){e.preventDefault();set(S[key]+d*step)}};
 rot();return set;
}
knob($('kVol'),'vol',-163,-140,140,()=>emit('volume',{value:S.vol}),.03);
knob($('kBal'),'bal',10,-135,135,()=>emit('balance',{value:S.bal*2-1}),.04);
knob($('kTun'),'tun',40,-135,135,tune,.2/20.5);
$('kBal').ondblclick=()=>{S.bal=.5;$('kBal').style.transform='rotate(-10deg)';emit('balance',{value:0})};

// optional deck buttons: rewind / fast forward flash when clicked, record latches on/off.
// Set any of these to false to disable that button completely (no click area, no event).
const BUTTONS={rewind:true,forward:true,record:true};
[['rewind',573,'Previous song','gRew',true],['forward',625,'Next song','gFwd',true],['record',677,'Request a song','gRec',false]].forEach(([k,left,label,cls,pulse])=>{
 if(!BUTTONS[k])return;
 const b=document.createElement('div');b.className='hit btn';b.style.left=left+'px';b.tabIndex=0;b.setAttribute('role','button');b.setAttribute('aria-label',label);$('stage').appendChild(b);
 const gs=document.querySelectorAll('.'+cls);
 act(b,()=>{if(pulse){gs.forEach(e=>e.classList.add('on'));setTimeout(()=>gs.forEach(e=>e.classList.remove('on')),600);emit(k==='rewind'?'previous':'next',{})}
  else{const on=!gs[0].classList.contains('on');gs.forEach(e=>e.classList.toggle('on',on));emit('record',{on})}})});

// display panel expand/collapse
const pan=$('panel');
function setOpen(o){pan.classList.toggle('collapsed',!o);$('tgl').textContent=o?'▴':'▾';$('tgl').setAttribute('aria-expanded',o);emit('display',{open:o});try{localStorage.setItem('rfm-open',o?'1':'0')}catch(e){}}
$('tgl').onclick=()=>setOpen(pan.classList.contains('collapsed'));
try{if(localStorage.getItem('rfm-open')==='0')setOpen(false)}catch(e){}

// logo: file pattern <decade>s-white.png / <decade>s-black.png in LOGO_BASE
const LOGO_BASE='logos/';let dark=false,logoDec=0;
// boom box art swaps with the theme: boom-box-white.png / boom-box-black.png in BOX_BASE (falls back to the built-in image if missing)
const BOX_BASE='images/';let boxUrl='';
function setBox(){const u=BOX_BASE+'boom-box-'+(dark?'black':'white')+'.png';if(u===boxUrl)return;boxUrl=u;
 const im=new Image(),r=document.body.style;
 im.onload=()=>{if(u===boxUrl)r.setProperty('--img','url('+u+')')};
 im.onerror=()=>{if(u===boxUrl)r.removeProperty('--img')};
 im.src=u;}
function paintLogo(){const i=$('logo'),f=$('fb');document.body.classList.toggle('dark',dark);setBox();if(!logoDec){i.style.display='none';f.style.display='none';i.removeAttribute('src');$('logoBar').style.cursor='default';return}$('logoBar').style.cursor='pointer';
 i.style.display='block';f.style.display='none';
 i.onerror=()=>{i.style.display='none';f.style.display='block';f.textContent='RetroFM \u00B7 '+logoDec+'s'};
 i.src=LOGO_BASE+logoDec+'s-'+(dark?'black':'white')+'.png';}
function setSongYear(y){const d=Math.floor(y/10)*10;if(d>=1960&&d<=2020){logoDec=d;paintLogo()}}
const flip=()=>{if(!logoDec)return;dark=!dark;paintLogo();emit('theme',{dark})};
$('logoBar').onclick=flip;$('logoBar').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();flip()}};
document.addEventListener('retrofm:song',e=>{const d=e.detail||{};if(d.title)setSong(d);if(d.year)setSongYear(d.year)});
window.RetroFM={setSongYear,setSong,setTransport:s=>setState(s,true)};

// tuning: dial = FM frequency, locks onto the selected decade's genre stations
const MIN=87.5,SPAN=20.5;let lastKey='';
function tune(){
 const f=Math.round((MIN+S.tun*SPAN)*10)/10;S.tun=(f-MIN)/SPAN;
 $('kTun').style.transform='rotate('+(-135+S.tun*270-40)+'deg)';
 const x=fx(MIN+S.tun*SPAN);$('tn').setAttribute('x1',x);$('tn').setAttribute('x2',x);
 let best=null;ST[S.dec].forEach(s=>{const d=Math.abs(s[1]-f);if(d<=.3&&(!best||d<Math.abs(best[1]-f)))best=s});
 $('year').textContent=f.toFixed(1)+' FM';
 S.locked=!!best;
 $('gi').textContent=best?'':'Between stations';
 document.querySelectorAll('.chip').forEach(c=>c.classList.toggle('sel',!!best&&c.dataset.g===best[0]));
 const key=S.dec+'|'+(best?best[0]:'');
 if(best){$('hGen').textContent=best[0].toUpperCase();if(gl===ST[S.dec])gi=gl.indexOf(best)}
 if(key!==lastKey){lastKey=key;song=null;renderSong();marks();if(DEMO&&best&&pan.classList.contains('live')){const k=key;setTimeout(()=>{if(!song&&lastKey===k)setSong(demoFor(best[0]))},1200)}if(pan.classList.contains('live'))emit('tune',{decade:S.dec,frequency:f,genre:best?best[0]:null,locked:!!best})}
}
function setDec(d){S.dec=d;lastKey='';
 document.querySelectorAll('.dec').forEach(b=>b.classList.toggle('sel',+b.textContent===d));
 logoDec=d;paintLogo();$('chips').innerHTML='';
 [...ST[d]].sort((a,b)=>a[1]-b[1]).forEach(s=>{const b=document.createElement('button');b.className='chip';b.dataset.g=s[0];b.textContent=s[0];b.title=s[1].toFixed(1)+' FM';
  b.onclick=()=>{S.tun=(s[1]-MIN)/SPAN;tune()};$('chips').appendChild(b)});
 tune();}
// FM scale drawn to match the dial: x position for a frequency (88 to 108 MHz)
const fx=f=>330+(f-87.5)*27.3;
(function(){let h='';for(let f=88;f<=108;f++){const M=f%4===0,x=fx(f).toFixed(1);
 h+='<line x1="'+x+'" x2="'+x+'" y1="'+(M?158:163)+'" y2="168" stroke="#3d3a37" stroke-width="'+(M?1.8:1.1)+'"/>';
 if(M)h+='<text x="'+x+'" y="153" text-anchor="middle" font-size="15" fill="#3d3a37" font-family="system-ui,sans-serif">'+f+'</text>'}
 $('scale').innerHTML=h})();
function marks(){$('stn').innerHTML=ST[S.dec].map(s=>'<circle cx="'+fx(s[1]).toFixed(1)+'" cy="180" r="3.4" fill="#c8741a"/>').join('')}
// placeholder song so the fade can be previewed; set DEMO=false once the app sends real songs
const DEMO=true,DEMOS={'AOR':['Baker Street','Gerry Rafferty'],'Disco':['Le Freak','Chic'],'Grunge':['Smells Like Teen Spirit','Nirvana'],'Motown':['My Girl','The Temptations'],'New Wave':['Don\'t You Want Me','The Human League'],'Synth-Pop':['Tainted Love','Soft Cell']};
const demoFor=g=>{const s=DEMOS[g]||['Sample Song Title','Sample Artist'];return{title:s[0],artist:s[1]}};
// song info on the display: title and artist fade in turn (dot toggles); setSong({title,artist,year})
let song=null,fadeOn=true,phase=0,sTimer=0;
function renderSong(){const el=$('sg');clearInterval(sTimer);el.className='';el.style.opacity=1;el.title='';
 if(!fadeOn){el.textContent='';return}
 if(!S.locked){el.textContent='\u2591 static \u2591';return}
 if(!song){el.textContent='Finding a song\u2026';el.className='dim';return}
 el.title=song.title+(song.artist?' by '+song.artist:'');
 if(!song.artist){el.textContent=song.title;return}
 el.textContent=song.title;phase=1;el.style.opacity=0;requestAnimationFrame(()=>requestAnimationFrame(()=>{el.style.opacity=1}));sTimer=setInterval(showSong,9000)}
function showSong(){const el=$('sg');if(!song)return;el.style.opacity=0;setTimeout(()=>{if(!song)return;el.textContent=phase?song.artist:song.title;el.style.opacity=1;phase^=1},1500)}
function setSong(d){song=d&&d.title?{title:String(d.title),artist:String(d.artist||'')}:null;renderSong()}
$('sdot').onclick=()=>{fadeOn=!fadeOn;$('sdot').setAttribute('aria-pressed',fadeOn);$('sdot').title=fadeOn?'Hide song info':'Show song info';renderSong()};

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
  flap(fG,gl[gi][0]);hint.textContent=step==='genre'?'\u2191\u2193 CHOOSE GENRE \u00B7 ENTER TO TUNE IN \u00B7 TAB: DATE':'ENTER OR TAB TO CHOOSE A GENRE';hint.className=''}
 else{flap(fD,v||'TYPE A DATE',!v);gl=[];flap(fG,'GENRE',1);
  const p=q?'':problem(v);hint.textContent=p||(v.length>5?'Try July 4, 1978 \u00B7 1960 to today':'e.g. July 4, 1978');hint.className=p?'err':''}
 brd.dataset.s=step;caret()}
function cyc(d){if(!D)return;gi=(gi+d+gl.length)%gl.length;flap(fG,gl[gi][0])}
function goLive(){const y=D.getFullYear(),dec=Math.floor(y/10)*10,g=gl[gi];
 pan.classList.replace('entry','live');
 $('hDate').textContent=MON[D.getMonth()]+' '+D.getDate()+', '+y;$('hGen').textContent=g[0].toUpperCase();
 S.tun=(g[1]-MIN)/SPAN;setDec(dec);
 emit('select',{date:y+'-'+String(D.getMonth()+1).padStart(2,'0')+'-'+String(D.getDate()).padStart(2,'0'),year:y,decade:dec,genre:g[0],frequency:g[1]})}
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
$('hDate').onclick=()=>back('date');$('hGen').onclick=()=>back('genre');
tune();refresh();dIn.focus();

// VU meters (simulated: the music plays in the YouTube tab, so no audio to analyse)
let env=0,nl=0,nr=0,beat=.5;
function vu(){
 if(S.state==='playing'){if(Math.random()<.14)beat=.35+Math.random()*.55;env+=(beat-env)*.3}else env*=.9;
 const v=.55+.45*S.vol,gl=S.bal<=.5?1:2*(1-S.bal),gr=S.bal>=.5?1:2*S.bal;
 const tl=S.state==='playing'?env*gl*v*(.92+Math.random()*.16):0,tr=S.state==='playing'?env*gr*v*(.92+Math.random()*.16):0;
 nl+=(tl-nl)*(tl>nl?.35:.1);nr+=(tr-nr)*(tr>nr?.35:.1);
 aim('nl',833,nl);aim('nr',957,nr);requestAnimationFrame(vu);
}
function aim(id,px,l){const a=(-47+clamp(l)*94)*Math.PI/180,n=$(id);n.setAttribute('x2',px+Math.sin(a)*58);n.setAttribute('y2',352-Math.cos(a)*58)}
vu();

$('copy').onclick=e=>e.stopPropagation();
