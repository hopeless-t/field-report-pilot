'use strict';
const DB_NAME='field-report-pilot-v1';
const DB_VERSION=2;
const $=s=>document.querySelector(s);
const state={db:null,site:null,visit:null,activePlace:null,activeStage:'',activeWorkCategory:'ゴキブリトラップ',photos:[],resolvingPhotoId:null,editingPhotoId:null,pendingCoverPhoto:null,coverPreviewURL:null,coverThumbURL:null,showUnresolvedOnly:false,reportHTML:null,reportFilename:null,returnToReportAfterEdit:false,hatStep:null,hatEnteredAt:Date.now(),hatSessionId:null,hatSequence:0,hatOrigin:'INTERACTION_PROXY',visitHistory:[],visitSwitchBusy:false};

const BUILTIN_PRESETS=[
 ['異常なし','異常は確認されませんでした'],
 ['喫食なし','喫食はありませんでした'],
 ['捕獲・目撃なし','捕獲・目撃はありませんでした'],
 ['侵入痕跡なし','侵入痕跡は確認されませんでした']
];
const STAGE_ORDER=new Map([['施工前',0],['作業中',1],['施工後',2],['確認点',3],['',9]]);
const WORK_CATEGORIES=['ゴキブリトラップ','ネズミ固形剤','ネズミ粉剤','衛生管理報告','特別報告'];
const WORK_CATEGORY_ORDER=new Map(WORK_CATEGORIES.map((x,i)=>[x,i]));
function normalizeWorkCategory(value){return WORK_CATEGORY_ORDER.has(value)?value:''}
function photoWorkCategory(photo){return normalizeWorkCategory(photo?.workCategory)||inferLegacyWorkCategory(photo)||''}
function inferLegacyWorkCategory(photo){
 const text=`${pathLabel(effectivePlace(photo))} ${photoComment(photo)}`;
 if(/ゴキブリ|ゴキ|粘着トラップ|捕虫/.test(text))return 'ゴキブリトラップ';
 if(/固形剤|喫食|ベイト/.test(text))return 'ネズミ固形剤';
 if(/粉剤|粉跡|足跡/.test(text))return 'ネズミ粉剤';
 if(/衛生管理|衛生|清掃確認/.test(text))return '衛生管理報告';
 if(/特別報告|特記事項/.test(text))return '特別報告';
 return '';
}
function categoryLabel(value){const i=WORK_CATEGORIES.indexOf(value);return i>=0?`${i+1}. ${value}`:'未分類'}
const SITE_SEEDS=[
 {match:/^ハイム大川(?:103)?$/,address:'東京都渋谷区本町6-1-22 ハイム大川103'}
];
function seedForSiteName(name){return SITE_SEEDS.find(x=>x.match.test(String(name||'').trim()))||null}
function withSiteSeed(site){const seed=seedForSiteName(site?.name);if(!seed)return site;return {...site,address:site.address||seed.address,seedSource:site.seedSource||'known-site-kv'}}
function isCoverCandidate(photo){const place=pathLabel(effectivePlace(photo));return /(店舗?外観|建物外観|外観|正面|ファサード|エントランス外)/.test(place)}
function siteKV(site=state.site){const kv=site?.kvCache||{};return {lastWorkTitle:String(kv.lastWorkTitle||''),recentComments:Array.isArray(kv.recentComments)?kv.recentComments.filter(Boolean).slice(0,8):[],placementCounts:kv.placementCounts&&typeof kv.placementCounts==='object'?kv.placementCounts:{},placementByPhoto:kv.placementByPhoto&&typeof kv.placementByPhoto==='object'?kv.placementByPhoto:{},commentsByPlacement:kv.commentsByPlacement&&typeof kv.commentsByPlacement==='object'?kv.commentsByPlacement:{},customPresets:Array.isArray(kv.customPresets)?kv.customPresets.filter(Boolean).slice(0,12):[]}}
function fastHash(input){let h=2166136261;for(const ch of String(input)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}return (h>>>0).toString(16).padStart(8,'0')}
function photoCapability(photo){
 const place=pathLabel(effectivePlace(photo));const stage=photoStage(photo).trim();const workCategory=photoWorkCategory(photo);const comment=photoComment(photo).trim();const readable=!!imageBlobFromRecord(photo);
 const provenance=photo.placeSnapshot?'capture':photo.placeResolution?'late':'unknown';
 const roles=[workCategory||'work-unknown',stage||'stage-unknown',comment?'commented':'comment-missing',readable?'image-readable':'image-missing',provenance];
 const placement=`${workCategory||'未分類'}|${place}|${stage||'未区分'}`;return {hash:fastHash(`${placement}|${roles.join('|')}`),workCategory,place,stage,roles,placement,readable};
}
function placedPhotosForReport(photos){
 const firstSeen=new Map();photos.forEach((p,i)=>{const c=photoCapability(p),key=`${c.workCategory}|${c.place}`;if(!firstSeen.has(key))firstSeen.set(key,i)});
 return photos.slice().sort((a,b)=>{const ca=photoCapability(a),cb=photoCapability(b);const wa=WORK_CATEGORY_ORDER.get(ca.workCategory)??99,wb=WORK_CATEGORY_ORDER.get(cb.workCategory)??99;if(wa!==wb)return wa-wb;const ka=`${ca.workCategory}|${ca.place}`,kb=`${cb.workCategory}|${cb.place}`;const pa=firstSeen.get(ka)??9999,pb=firstSeen.get(kb)??9999;if(pa!==pb)return pa-pb;const sa=STAGE_ORDER.get(ca.stage)??8,sb=STAGE_ORDER.get(cb.stage)??8;if(sa!==sb)return sa-sb;return String(a.capturedAt).localeCompare(String(b.capturedAt))})
}

async function updateSiteKV(mutator){if(!state.site||state.site.placeholder)return;const next=mutator(siteKV(state.site));state.site={...state.site,kvCache:next,updatedAt:isoNow()};await put('sites',state.site)}
async function learnComment(comment){const value=String(comment||'').trim();if(!value)return;await updateSiteKV(kv=>({...kv,recentComments:[value,...kv.recentComments.filter(x=>x!==value)].slice(0,8)}))}
async function learnPlacement(photo){if(!state.site||state.site.placeholder)return;const c=photoCapability(photo);await updateSiteKV(kv=>{const counts={...kv.placementCounts};const byPhoto={...kv.placementByPhoto};const old=byPhoto[photo.id]||'';const next=(c.place==='場所未設定'||!c.stage)?'':c.placement;if(old===next)return kv;if(old){counts[old]=Math.max(0,(counts[old]||1)-1);if(!counts[old])delete counts[old]}if(next){counts[next]=(counts[next]||0)+1;byPhoto[photo.id]=next}else delete byPhoto[photo.id];return {...kv,placementCounts:counts,placementByPhoto:byPhoto}})}
async function learnCommentForPlacement(photo,comment){
 const value=String(comment||'').trim();const c=photoCapability({...photo,comment:value});if(!value||c.place==='場所未設定'||!c.stage)return;
 await updateSiteKV(kv=>{const map={...kv.commentsByPlacement};const list=Array.isArray(map[c.placement])?[...map[c.placement]]:[];if(!list.includes(value))list.unshift(value);map[c.placement]=list.slice(0,6);return {...kv,commentsByPlacement:map}})
}
function bestPlacementComment(photo){const c=photoCapability(photo);if(c.place==='場所未設定'||!c.stage)return '';const list=siteKV().commentsByPlacement[c.placement];return Array.isArray(list)&&list.length===1?String(list[0]||''):''}
async function maybePromoteCover(photo,reason='cHash-cover'){
 if(!state.site||state.site.placeholder||imageBlobFromRecord(state.site)||!isCoverCandidate(photo))return false;
 const bytes=bytesFromRecord(photo.bytes||photo.imageBytes);if(!bytes?.byteLength)return false;
 state.site={...state.site,coverPhotoBytes:bytes,coverPhotoType:photo.type||'image/jpeg',coverPhotoName:photo.name||'storefront.jpg',coverPhotoSource:{photoId:photo.id,reason,at:isoNow()},updatedAt:isoNow()};await put('sites',state.site);await recordEvent('cover_auto_promoted',{photoId:photo.id,reason});return true
}
async function confirmCoverPhoto(photoId,closeDialog=false){
 const photo=state.photos.find(p=>p.id===photoId);if(!photo)return;
 const bytes=bytesFromRecord(photo.bytes||photo.imageBytes);if(!bytes?.byteLength)return setStatus('この写真の画像データを読み込めません');
 state.site={...state.site,coverPhotoBytes:bytes,coverPhotoType:photo.type||'image/jpeg',coverPhotoName:photo.name||'storefront.jpg',coverPhotoSource:{photoId:photo.id,reason:'user-confirmed',at:isoNow()},updatedAt:isoNow()};await put('sites',state.site);await recordEvent('cover_confirmed',{photoId:photo.id});setStatus('この写真を表紙として記憶しました。次回から自動で使います');if(closeDialog&&$('#photoDetailDialog').open)$('#photoDetailDialog').close();render()
}
async function setCoverFromPhoto(){return confirmCoverPhoto(state.editingPhotoId,true)}
async function applySafeKVCoverage(){
 let stageFilled=0,commentFilled=0,coverFilled=0;
 const photos=state.photos.slice().sort((a,b)=>String(a.capturedAt).localeCompare(String(b.capturedAt)));
 for(let i=0;i<photos.length;i++){
  let p=photos[i];if(photoStage(p).trim())continue;const place=pathLabel(effectivePlace(p));if(place==='場所未設定')continue;
  let before=null,after=null;
  for(let j=i-1;j>=0;j--){if(pathLabel(effectivePlace(photos[j]))===place&&photoStage(photos[j]).trim()){before=photoStage(photos[j]).trim();break}}
  for(let j=i+1;j<photos.length;j++){if(pathLabel(effectivePlace(photos[j]))===place&&photoStage(photos[j]).trim()){after=photoStage(photos[j]).trim();break}}
  if(before&&before===after){p={...p,stage:before,stageSource:'bounded-neighbor'};await put('photos',p);photos[i]=p;const idx=state.photos.findIndex(x=>x.id===p.id);if(idx>=0)state.photos[idx]=p;await learnPlacement(p);stageFilled++}
 }
 for(let i=0;i<state.photos.length;i++){
  let p=state.photos[i];if(!photoComment(p).trim()){const learned=bestPlacementComment(p);if(learned){p={...p,comment:learned,commentSource:'kv-placement'};await put('photos',p);state.photos[i]=p;commentFilled++}}
  if(await maybePromoteCover(state.photos[i]))coverFilled++;
 }
 if(stageFilled||commentFilled||coverFilled)await recordEvent('safe_kv_coverage',{stageFilled,commentFilled,coverFilled});
 return {stageFilled,commentFilled,coverFilled}
}

function uuid(){return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}
function isoNow(){return new Date().toISOString()}
function localDay(){const d=new Date();const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`}
function pathLabel(path){return path?.length?path.join('・'):'場所未設定'}
function isUnresolved(photo){return !photo.placeSnapshot && !photo.placeResolution}
function effectivePlace(photo){return photo.placeSnapshot?.path || photo.placeResolution?.path || null}
function photoStage(photo){return String(photo?.stage||'')}
function photoComment(photo){return String(photo?.comment||'')}
function needsReportDetail(photo){return !photoStage(photo).trim() || !photoComment(photo).trim()}
function safeFilename(value){return String(value||'Field-REPORT').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,80)}
function bytesFromRecord(value){
 if(value instanceof ArrayBuffer)return value;
 if(ArrayBuffer.isView(value))return value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength);
 return null;
}
function imageBlobFromRecord(record){
 if(!record)return null;
 const bytes=bytesFromRecord(record.bytes||record.imageBytes||record.coverPhotoBytes);
 if(bytes&&bytes.byteLength)return new Blob([bytes],{type:record.type||record.imageType||record.coverPhotoType||'image/jpeg'});
 if(record.blob instanceof Blob&&record.blob.size)return record.blob;
 if(record.coverPhotoBlob instanceof Blob&&record.coverPhotoBlob.size)return record.coverPhotoBlob;
 return null;
}
async function fileToDurableImage(file){
 if(!(file instanceof Blob)||!file.size)throw new Error('image file unavailable');
 const bytes=await file.arrayBuffer();
 if(!bytes.byteLength)throw new Error('image file empty');
 return {bytes,type:file.type||'image/jpeg',name:file.name||'photo.jpg'};
}
async function imageRecordToDataURL(record){
 try{
  if(typeof record?.dataURL==='string'&&record.dataURL.startsWith('data:image/'))return record.dataURL;
  const blob=imageBlobFromRecord(record);
  if(!blob)return '';
  return await blobToDataURL(blob);
 }catch(e){console.warn('image readback failed',record?.id||record?.name||'<unknown>',e);return ''}
}
function imageRecordObjectURL(record){
 try{const blob=imageBlobFromRecord(record);return blob?URL.createObjectURL(blob):''}catch{return ''}
}

function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains('sites'))db.createObjectStore('sites',{keyPath:'id'});if(!db.objectStoreNames.contains('visits'))db.createObjectStore('visits',{keyPath:'id'});if(!db.objectStoreNames.contains('photos')){const s=db.createObjectStore('photos',{keyPath:'id'});s.createIndex('visitId','visitId')}if(!db.objectStoreNames.contains('events'))db.createObjectStore('events',{keyPath:'id'})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
function tx(store,mode='readonly'){return state.db.transaction(store,mode).objectStore(store)}
function put(store,val){return new Promise((res,rej)=>{const r=tx(store,'readwrite').put(val);r.onsuccess=()=>res(val);r.onerror=()=>rej(r.error)})}
function getAll(store){return new Promise((res,rej)=>{const r=tx(store).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function getByIndex(store,index,key){return new Promise((res,rej)=>{const r=tx(store).index(index).getAll(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
function countByIndex(store,index,key){return new Promise((res,rej)=>{const r=tx(store).index(index).count(key);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}
async function recordEvent(type,detail={}){if(!state.db)return;try{const hat=type.startsWith('hat_')?{hatSessionId:state.hatSessionId,hatOrigin:state.hatOrigin,hatSequence:++state.hatSequence}:{};await put('events',{id:uuid(),type,at:isoNow(),siteId:state.site?.id||null,visitId:state.visit?.id||null,...hat,...detail})}catch(e){console.warn('ledger event failed',type,e)}}

async function init(){
 const hatQuery=new URLSearchParams(location.search);state.hatSessionId=uuid();state.hatOrigin=hatQuery.get('selftest')==='1'?'SYNTHETIC_SELFTEST':hatQuery.get('ux_probe')==='1'?'SYNTHETIC_PROBE':'INTERACTION_PROXY';
 state.db=await openDB();
 if('serviceWorker'in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
 if(navigator.storage?.persist) navigator.storage.persist().catch(()=>{});
 const sites=await getAll('sites');
 const last=localStorage.getItem('field-report-last-site');
 state.site=sites.find(s=>s.id===last)||null;
 if(state.site) await startOrResumeVisit(state.site);
 bind(); render();
}

async function ensureWorkingContext(){
 if(state.site && state.visit)return;
 if(!state.site){
  const site={id:uuid(),name:'現場未設定',placeholder:true,places:[],customerCompany:'',address:'',reportTitle:'作業報告書',basicWork:'',coverPhotoBlob:null,kvCache:{lastWorkTitle:'',recentComments:[],placementCounts:{},placementByPhoto:{},commentsByPlacement:{},customPresets:[]},createdAt:isoNow(),updatedAt:isoNow()};
  await put('sites',site);state.site=site;localStorage.setItem('field-report-last-site',site.id);await recordEvent('site_auto_created');
 }
 await startOrResumeVisit(state.site);
}

function visitSelectionKey(siteId){return `field-report-selected-visit:${siteId}`}
async function refreshVisitHistory(){
 if(!state.site){state.visitHistory=[];return []}
 const rows=(await getAll('visits')).filter(v=>v.siteId===state.site.id).sort((a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||'')));
 state.visitHistory=await Promise.all(rows.map(async visit=>({visit,photoCount:await countByIndex('photos','visitId',visit.id)})));
 return state.visitHistory;
}
async function loadSavedVisit(visit){
 if(!visit||visit.siteId!==state.site?.id)throw new Error('visit/site mismatch');
 state.visit=visit;localStorage.setItem(visitSelectionKey(state.site.id),visit.id);
 state.activePlace=visit.currentPlaceId?(state.site.places||[]).find(p=>p.id===visit.currentPlaceId)||null:null;
 state.activeStage=String(visit.currentStage||'');state.activeWorkCategory=normalizeWorkCategory(visit.currentWorkCategory)||'ゴキブリトラップ';
 state.resolvingPhotoId=null;state.editingPhotoId=null;state.showUnresolvedOnly=false;
 state.photos=(await getByIndex('photos','visitId',visit.id)).sort((a,b)=>String(a.capturedAt).localeCompare(String(b.capturedAt)));
 await refreshVisitHistory();render();
}
async function startOrResumeVisit(site,{forceNew=false,selectVisitId=null}={}){
 // Never discard a historical visit merely because today's workDate changed.
 site=withSiteSeed(site);state.site=site;localStorage.setItem('field-report-last-site',site.id);
 const history=await refreshVisitHistory();let visit=null;
 if(selectVisitId){visit=history.find(x=>x.visit.id===selectVisitId)?.visit||null;if(!visit)throw new Error('saved visit not found')}
 else if(!forceNew){
  const explicit=localStorage.getItem(visitSelectionKey(site.id));
  visit=history.find(x=>x.visit.id===explicit)?.visit || history.find(x=>x.photoCount>0)?.visit || history.find(x=>!x.visit.completedAt&&x.visit.workDate===localDay())?.visit || history[0]?.visit || null;
 }
 if(!visit){
  visit={id:uuid(),siteId:site.id,workDate:localDay(),workerName:localStorage.getItem('field-report-last-worker')||'',workTitle:'',specialNotes:'',currentPlaceId:null,currentStage:'',currentWorkCategory:'ゴキブリトラップ',startedAt:isoNow(),completedAt:null};
  await put('visits',visit);await recordEvent('visit_started',{visitId:visit.id});
 }
 await loadSavedVisit(visit);
}
async function openVisitHistory(){await refreshVisitHistory();renderVisitHistoryList();$('#visitHistoryDialog').showModal()}
function renderVisitHistoryList(){
 const root=$('#visitHistoryList');root.innerHTML='';
 for(const {visit,photoCount} of state.visitHistory){
  const b=document.createElement('button');b.type='button';b.className='visit-history-choice';
  const active=visit.id===state.visit?.id;
  b.textContent=`${visit.workDate}　写真${photoCount}枚　${visit.completedAt?'完了':'作業中'}${active?'　（表示中）':''}`;
  b.onclick=async()=>{
   if(state.visitSwitchBusy)return;state.visitSwitchBusy=true;b.disabled=true;setStatus('保存済みの訪問と写真を読み込んでいます…');
   try{await loadSavedVisit(visit);$('#visitHistoryDialog').close();setStatus(`${visit.workDate} の訪問を開きました。保存済み写真 ${state.photos.length}枚を読み込みました`)}
   catch(e){console.error(e);setStatus('以前の訪問を開けませんでした。保存データは変更していません')}
   finally{state.visitSwitchBusy=false;b.disabled=false}
  };
  root.append(b)
 }
 if(!state.visitHistory.length){const p=document.createElement('p');p.textContent='この現場の訪問記録はまだありません';root.append(p)}
}
async function startNewVisit(){
 if(!state.site||state.site.placeholder)return setStatus('先に現場を選んでください');
 if(state.visitSwitchBusy)return;state.visitSwitchBusy=true;
 try{
  await refreshVisitHistory();
  const emptyToday=state.visitHistory.find(x=>x.visit.workDate===localDay()&&!x.visit.completedAt&&!x.photoCount);
  if(emptyToday)await loadSavedVisit(emptyToday.visit);
  else await startOrResumeVisit(state.site,{forceNew:true});
  if($('#visitHistoryDialog').open)$('#visitHistoryDialog').close();
  setStatus('今日の作業を開きました。過去の写真・報告は保存したままです')
 }catch(e){console.error(e);setStatus('新しい作業を開けませんでした。過去の保存データは保持しています')}
 finally{state.visitSwitchBusy=false}
}
function renderVisitRecovery(){
 const box=$('#visitRecovery');if(!box)return;
 const isNamed=state.site&&!state.site.placeholder;
 box.hidden=!isNamed;if(!isNamed)return;
 const older=state.visitHistory.filter(x=>x.visit.id!==state.visit?.id&&x.photoCount>0);
 const current=state.visitHistory.find(x=>x.visit.id===state.visit?.id);
 const isPrior=!!state.visit&&state.visit.workDate!==localDay();
 const text=isPrior?`保存済みの ${state.visit.workDate} の作業を表示中（写真${state.photos.length}枚）。新しい作業は別に開始できます。`:
  !state.photos.length&&older.length?`今日の表示には写真がありませんが、過去の訪問に${older.reduce((n,x)=>n+x.photoCount,0)}枚の記録があります。消去せず確認できます。`:
  `この現場の保存済み訪問 ${state.visitHistory.length}件・表示中の写真 ${current?.photoCount??state.photos.length}枚。`;
 $('#visitRecoverySummary').textContent=text;
 $('#visitRecovery').classList.toggle('visit-recovery-alert',!!older.length&&!state.photos.length);
 $('#visitHistoryButton').textContent=older.length&&!state.photos.length?'以前の写真・報告を取り戻す':'訪問履歴・写真を確認';
}

function bind(){
 const openSiteDialog=()=>{renderSites();$('#siteDialog').showModal()};
 $('#siteButton').onclick=openSiteDialog;
 $('#visitHistoryButton').onclick=openVisitHistory;
 $('#closeVisitHistoryButton').onclick=()=>$('#visitHistoryDialog').close();
 $('#newVisitButton').onclick=startNewVisit;
 $('#historyNewVisitButton').onclick=startNewVisit;
 $('#startSiteButton').onclick=openSiteDialog;
 $('#reportMetaButton').onclick=openReportMeta;
 $('#helpButton').onclick=()=>$('#helpDialog').showModal();
 $('#closeHelpButton').onclick=()=>$('#helpDialog').close();
 $('#closeReportMetaButton').onclick=closeReportMeta;
 $('#saveReportMetaButton').onclick=saveReportMeta;
 $('#reportCoverPhoto').onchange=e=>previewCoverPhoto(e.target.files?.[0]||null);
 $('#quickCoverPhoto').onchange=e=>saveQuickCover(e.target.files?.[0]||null,{returnToReport:true,source:'library'});
 $('#coverCapture').onchange=e=>saveQuickCover(e.target.files?.[0]||null,{returnToReport:false,source:'library'});
 document.querySelectorAll('.work-category-choice').forEach(button=>{button.onclick=()=>setWorkCategory(button.dataset.workCategory||'')});
 $('#nextWorkCategoryButton').onclick=advanceWorkCategory;
 document.querySelectorAll('.stage-choice').forEach(button=>{button.onclick=async()=>{state.activeStage=button.dataset.stage||'';if(state.visit){state.visit={...state.visit,currentStage:state.activeStage};await put('visits',state.visit)}recordEvent('capture_stage_selected',{stage:state.activeStage});setStatus(`${state.activeStage} を保持します。変わるまで選び直し不要です`);render()}});
 $('#placeButton').onclick=()=>openPlaceDialog(null);
 $('#moveButton').onclick=()=>clearActivePlace();
 $('#createSiteButton').onclick=createOrNameSite;
 $('#createPlaceButton').onclick=createPlace;
 $('#photoImport').onchange=e=>captureFiles(e.target.files,{source:'library'});
 $('#unresolvedButton').onclick=toggleUnresolved;
 $('#finishButton').onclick=requestFinish;
 $('#finishReviewButton').onclick=()=>{state.showUnresolvedOnly=true;$('#finishDialog').close();render();document.querySelector('#photoGrid')?.scrollIntoView({behavior:'smooth',block:'start'})};
 $('#finishAnywayButton').onclick=async()=>{$('#finishDialog').close();await completeAndOpenReport()};
 $('#reportButton').onclick=openReportPreview;
 $('#closeReportButton').onclick=()=>$('#reportDialog').close();
 $('#editReportMetaButton').onclick=()=>editReportMetaFromPreview();
 $('#shareEditableHTMLButton').onclick=shareEditableHTML;
 $('#savePhotosButton').onclick=sharePhotosToLibrary;
 $('#shareReportButton').onclick=shareReport;
 $('#printReportButton').onclick=savePDFReport;
 $('#printOnlyButton').onclick=()=>window.print();
 $('#installHelpButton').onclick=()=>$('#installDialog').showModal();
 $('#journeyPrimaryAction').onclick=runJourneyPrimaryAction;
 $('#journeySecondaryAction').onclick=runJourneySecondaryAction;
 document.addEventListener('click',observeHumanAction,{capture:true});
 $('#closeInstallButton').onclick=()=>$('#installDialog').close();
 $('#closePhotoDetailButton').onclick=()=>$('#photoDetailDialog').close();
 $('#savePhotoDetailButton').onclick=savePhotoDetail;
 $('#savePresetButton').onclick=saveCurrentCommentAsPreset;
 $('#makeCoverButton').onclick=setCoverFromPhoto;
 document.querySelectorAll('.preset-choice').forEach(button=>{button.onclick=()=>{$('#photoCommentInput').value=button.dataset.comment||''}});
}

async function createOrNameSite(){
 const name=$('#newSiteName').value.trim(); if(!name)return setStatus('現場名を入力してください');
 if(state.site?.placeholder && state.visit){
  state.site=withSiteSeed({...state.site,name,placeholder:false,updatedAt:isoNow()});await put('sites',state.site);await recordEvent('site_named_after_capture',{name});
  $('#newSiteName').value='';$('#siteDialog').close();setStatus(`${name} として現場を保存しました`);render();return;
 }
 const site=withSiteSeed({id:uuid(),name,placeholder:false,places:[],customerCompany:'',address:'',reportTitle:'作業報告書',basicWork:'',coverPhotoBlob:null,kvCache:{lastWorkTitle:'',recentComments:[],placementCounts:{},placementByPhoto:{},commentsByPlacement:{},customPresets:[]},createdAt:isoNow(),updatedAt:isoNow()});await put('sites',site);await recordEvent('site_created',{siteId:site.id});$('#newSiteName').value='';$('#siteDialog').close();await startOrResumeVisit(site);setStatus('新しい現場を開きました')
}

function releaseCoverPreview(){if(state.coverPreviewURL){URL.revokeObjectURL(state.coverPreviewURL);state.coverPreviewURL=null}}
function setCoverPreview(source){
 releaseCoverPreview();const img=$('#reportCoverPreview');
 const blob=source instanceof Blob?source:imageBlobFromRecord(source);
 if(blob){state.coverPreviewURL=URL.createObjectURL(blob);img.src=state.coverPreviewURL;img.hidden=false;$('#reportCoverStatus').textContent='この写真を表紙に大きく使います';img.onerror=()=>{img.hidden=true;$('#reportCoverStatus').textContent='表紙写真を読み込めません。報告書は作成できます'}}
 else{img.removeAttribute('src');img.hidden=true;$('#reportCoverStatus').textContent='表紙写真は未設定です'}
}
function renderPresetChoices(){
 const root=$('#presetChoices');if(!root)return;root.innerHTML='';
 const kv=siteKV(),cached=kv.recentComments;const items=[];const seen=new Set();
 for(const comment of kv.customPresets){if(seen.has(comment))continue;seen.add(comment);items.push(['定型',comment,'custom'])}
 for(const comment of cached){if(seen.has(comment))continue;seen.add(comment);items.push(['前回',comment,'cached'])}
 for(const [label,comment] of BUILTIN_PRESETS){if(seen.has(comment))continue;seen.add(comment);items.push([label,comment,'builtin'])}
 for(const [label,comment,kind] of items.slice(0,12)){const b=document.createElement('button');b.type='button';b.className='preset-choice';b.dataset.comment=comment;b.dataset.kind=kind;b.textContent=kind==='cached'?`↻ ${comment}`:kind==='custom'?`★ ${comment}`:label;b.onclick=()=>{$('#photoCommentInput').value=comment};root.append(b)}
}
async function saveCurrentCommentAsPreset(){
 const value=$('#photoCommentInput').value.trim();if(!value)return setStatus('先に報告文を入力してください');await updateSiteKV(kv=>({...kv,customPresets:[value,...kv.customPresets.filter(x=>x!==value)].slice(0,12)}));renderPresetChoices();setStatus('この文を定型文として保存しました。次回からワンタップで使えます')
}
function renderKVHints(){
 const root=$('#reportKVHints');if(!root)return;root.innerHTML='';const kv=siteKV();const current=$('#reportWorkTitle').value.trim();
 if(kv.lastWorkTitle&&kv.lastWorkTitle!==current){const b=document.createElement('button');b.type='button';b.className='kv-suggestion';b.textContent=`前回の作業を使う：${kv.lastWorkTitle}`;b.onclick=()=>{$('#reportWorkTitle').value=kv.lastWorkTitle;root.hidden=true};root.append(b);root.hidden=false}else root.hidden=true;
}
function editReportMetaFromPreview(){
 state.returnToReportAfterEdit=true;if($('#reportDialog').open)$('#reportDialog').close();openReportMeta()
}
function editPhotoFromPreview(photoId){
 state.returnToReportAfterEdit=true;if($('#reportDialog').open)$('#reportDialog').close();openPhotoDetail(photoId)
}
function openReportMeta(){
 if(!state.site||state.site.placeholder){setStatus('先に現場名を決めてください');return}
 $('#reportCustomerCompany').value=state.site.customerCompany||'';
 $('#reportSiteAddress').value=state.site.address||'';
 $('#reportTitleInput').value=state.site.reportTitle||'作業報告書';
 $('#reportWorkerName').value=state.visit?.workerName||localStorage.getItem('field-report-last-worker')||'';
 $('#reportWorkTitle').value=state.visit?.workTitle||'';
 $('#reportBasicWork').value=state.site.basicWork||'';
 $('#reportSpecialNotes').value=state.visit?.specialNotes||'';
 state.pendingCoverPhoto=null;$('#reportCoverPhoto').value='';setCoverPreview(state.site);renderKVHints();
 $('#reportMetaDialog').showModal();
}
function closeReportMeta(){releaseCoverPreview();state.pendingCoverPhoto=null;$('#reportMetaDialog').close()}
function previewCoverPhoto(file){state.pendingCoverPhoto=file||null;setCoverPreview(file||state.site)}
async function saveQuickCover(file,{returnToReport=false,source='library'}={}){
 if(!file||!state.site)return;const durable=await fileToDurableImage(file);const reason=returnToReport?'report-cover-picker':'cover-library-picker';state.site={...state.site,coverPhotoBytes:durable.bytes,coverPhotoType:durable.type,coverPhotoName:durable.name,coverPhotoSource:{reason,source,at:isoNow()},updatedAt:isoNow()};await put('sites',state.site);$('#quickCoverPhoto').value='';$('#coverCapture').value='';await recordEvent('cover_confirmed',{method:reason,source});setStatus('外観写真を表紙として保存しました。原本は写真アプリに残っています');render();if(returnToReport&&state.photos.length)await openReportPreview()
}
async function saveReportMeta(){
 if(!state.site||state.site.placeholder)return setStatus('現場名を先に決めてください');
 const customerCompany=$('#reportCustomerCompany').value.trim();const address=$('#reportSiteAddress').value.trim();const reportTitle=$('#reportTitleInput').value.trim()||'作業報告書';const basicWork=$('#reportBasicWork').value.trim();
 let coverFields={};
 if(state.pendingCoverPhoto){const durable=await fileToDurableImage(state.pendingCoverPhoto);coverFields={coverPhotoBytes:durable.bytes,coverPhotoType:durable.type,coverPhotoName:durable.name,coverPhotoBlob:null}}
 state.site={...state.site,customerCompany,address,reportTitle,basicWork,...coverFields,updatedAt:isoNow()};await put('sites',state.site);
 if(state.visit){const workerName=$('#reportWorkerName').value.trim();const workTitle=$('#reportWorkTitle').value.trim();const specialNotes=$('#reportSpecialNotes').value.trim();state.visit={...state.visit,workerName,workTitle,specialNotes};await put('visits',state.visit);if(workerName)localStorage.setItem('field-report-last-worker',workerName);if(workTitle)await updateSiteKV(kv=>({...kv,lastWorkTitle:workTitle}))}
 await recordEvent('report_metadata_saved',{hasCover:!!imageBlobFromRecord(state.site),hasAddress:!!address,hasWorker:!!state.visit?.workerName,kvLastWorkTitle:siteKV().lastWorkTitle||null});const backToReport=state.returnToReportAfterEdit;state.returnToReportAfterEdit=false;closeReportMeta();setStatus('報告書情報を保存しました。表紙・住所・基本作業は次回も使います');render();if(backToReport&&state.photos.length)await openReportPreview();
}

async function setWorkCategory(value){
 const category=normalizeWorkCategory(value);if(!category)return;state.activeWorkCategory=category;if(state.visit){state.visit={...state.visit,currentWorkCategory:category};await put('visits',state.visit)}await recordEvent('work_category_selected',{workCategory:category});setStatus(`${category} を保持します。工程が変わるまで選び直し不要です`);render()
}
async function advanceWorkCategory(){const i=WORK_CATEGORIES.indexOf(state.activeWorkCategory);if(i<0||i>=WORK_CATEGORIES.length-1)return setStatus('特別報告が最後の工程です');await setWorkCategory(WORK_CATEGORIES[i+1])}

async function clearActivePlace(){
 const from=state.activePlace;state.activePlace=null;if(state.visit){state.visit={...state.visit,currentPlaceId:null};await put('visits',state.visit)}await recordEvent('place_transition',{fromPlaceId:from?.id||null,toPlaceId:null,fromPath:from?.path||null,toPath:null,reason:'explicit-unresolved'});setStatus('場所未設定のまま、写真アプリから選べます。区分はそのまま保持しています');render()
}
function quickPlaceScore(place){const used=Date.parse(place.lastUsedAt||'')||0;let count=0;for(const [key,n] of Object.entries(siteKV().placementCounts)){if(key.startsWith(pathLabel(place.path)+'|'))count+=Number(n)||0}return used+count*1000}
function renderQuickPlaces(){
 const root=$('#quickPlaces');if(!root)return;root.innerHTML='';if(!state.site)return;
 const places=[...(state.site.places||[])].sort((a,b)=>{
  if(a.id===state.activePlace?.id)return -1;if(b.id===state.activePlace?.id)return 1;return quickPlaceScore(b)-quickPlaceScore(a)
 });
 for(const place of places){const b=document.createElement('button');b.type='button';b.className='quick-place';b.classList.toggle('active',place.id===state.activePlace?.id);b.textContent=pathLabel(place.path);b.onclick=()=>selectQuickPlace(place.id);root.append(b)}
 if(state.activePlace){const u=document.createElement('button');u.type='button';u.className='quick-place unresolved';u.textContent='場所未設定';u.onclick=clearActivePlace;root.append(u)}
}
async function selectQuickPlace(id){const p=state.site?.places.find(x=>x.id===id);if(!p||p.id===state.activePlace?.id)return;await applyPlace(p);render()}

function openPlaceDialog(photoId){
 if(!state.site){setStatus('場所はあとでも決められます。まず撮影できます');return}
 state.resolvingPhotoId=photoId;
 $('#placeDialogTitle').textContent=photoId?'この写真はどこ？':'いまどこ？';
 $('#createPlaceButton').textContent=photoId?'この場所を写真に付ける':'この場所で撮る';
 renderPlaces();$('#placeDialog').showModal();
}

async function createPlace(){
 if(!state.site)return setStatus('現場名はあとで決められます。まず撮影できます');
 const floor=$('#newFloorName').value.trim(), place=$('#newPlaceName').value.trim(); const path=[floor,place].filter(Boolean); if(!path.length)return setStatus('場所を入力してください');
 const existing=state.site.places.find(p=>JSON.stringify(p.path)===JSON.stringify(path));
 const item=existing||{id:uuid(),path,createdAt:isoNow()};
 if(!existing){state.site.places.push(item);state.site.updatedAt=isoNow();await put('sites',state.site);await recordEvent('place_created',{placeId:item.id,path})}
 await applyPlace(item);
 $('#newFloorName').value='';$('#newPlaceName').value='';$('#placeDialog').close();render();
}

async function selectSite(id){
 const sites=await getAll('sites');const site=sites.find(s=>s.id===id);if(!site)return;
 $('#siteDialog').close();
 // Capture-first reconciliation: if evidence was already recorded while the
 // site was UNKNOWN, keep that same visit and evidence. Record later site
 // confirmation separately instead of rewriting the capture-time snapshot.
 if(state.site?.placeholder && state.visit && state.photos.length){
  const fromSiteId=state.site.id;const resolvedAt=isoNow();
  state.visit={...state.visit,siteId:site.id};await put('visits',state.visit);
  const migrated=[];
  for(const photo of state.photos){
   const next={...photo,siteResolution:{id:site.id,name:site.name,resolvedAt}};
   await put('photos',next);migrated.push(next);
  }
  state.photos=migrated;state.site=site;state.activePlace=null;localStorage.setItem('field-report-last-site',site.id);await refreshVisitHistory();
  await recordEvent('site_late_resolved',{fromSiteId,selectedSiteId:id,photoCount:state.photos.length});
  setStatus(`${site.name} として現場を確認しました。先に撮った写真もそのまま残っています`);render();return;
 }
 await startOrResumeVisit(site);await recordEvent('site_selected',{selectedSiteId:id});setStatus('現場を開きました')
}
async function selectPlace(id){const p=state.site?.places.find(x=>x.id===id);if(p){await applyPlace(p);$('#placeDialog').close();render()}}
async function applyPlace(place){
 if(state.resolvingPhotoId){await resolvePhotoPlace(state.resolvingPhotoId,place);state.resolvingPhotoId=null;return}
 const from=state.activePlace;const now=isoNow();const idx=state.site?.places.findIndex(p=>p.id===place.id)??-1;const next={...place,lastUsedAt:now};if(idx>=0){state.site.places[idx]=next;state.site.updatedAt=now;await put('sites',state.site)}state.activePlace=next;if(state.visit){state.visit={...state.visit,currentPlaceId:next.id};await put('visits',state.visit)}await recordEvent('place_transition',{fromPlaceId:from?.id||null,toPlaceId:next.id,fromPath:from?.path||null,toPath:next.path});setStatus(`${pathLabel(next.path)} を保持します。標準カメラで撮影後、写真を選んでください`);
}

function openPhotoDetail(photoId){
 const photo=state.photos.find(p=>p.id===photoId);if(!photo)return;
 state.editingPhotoId=photoId;$('#photoWorkCategorySelect').value=photoWorkCategory(photo)||state.activeWorkCategory;$('#photoStageSelect').value=photoStage(photo);$('#photoCommentInput').value=photoComment(photo);renderPresetChoices();$('#makeCoverButton').hidden=!imageBlobFromRecord(photo);$('#photoDetailDialog').showModal();
}
async function savePhotoDetail(){
 const index=state.photos.findIndex(p=>p.id===state.editingPhotoId);if(index<0)return;
 const workCategory=normalizeWorkCategory($('#photoWorkCategorySelect').value)||state.activeWorkCategory;const stage=$('#photoStageSelect').value;const comment=$('#photoCommentInput').value.trim();
 const next={...state.photos[index],workCategory,stage,comment};await put('photos',next);state.photos[index]=next;
 if(workCategory&&workCategory!==state.activeWorkCategory){state.activeWorkCategory=workCategory;if(state.visit){state.visit={...state.visit,currentWorkCategory:workCategory};await put('visits',state.visit)}}
 if(stage){state.activeStage=stage;if(state.visit){state.visit={...state.visit,currentStage:stage};await put('visits',state.visit)}}
 await learnComment(comment);await learnCommentForPlacement(next,comment);await learnPlacement(next);await maybePromoteCover(next);const cHash=photoCapability(next).hash;
 await recordEvent('photo_detail_saved',{photoId:next.id,stage,hasComment:!!comment,cHash});
 const backToReport=state.returnToReportAfterEdit;state.returnToReportAfterEdit=false;$('#photoDetailDialog').close();state.editingPhotoId=null;const filled=await applySafeKVCoverage();const auto=filled.stageFilled+filled.commentFilled+filled.coverFilled;setStatus(auto?`写真を保存し、同じ文脈 ${auto}件も安全に自動補完しました`:'写真の区分と報告文を保存しました');render();if(backToReport)await openReportPreview();
}

async function captureFiles(files,{source='unknown'}={}){
 if(!files?.length)return;
 await ensureWorkingContext();
 for(const file of [...files]){
  const durable=await fileToDurableImage(file);
  let photo={id:uuid(),visitId:state.visit.id,siteSnapshot:{id:state.site.id,name:state.site.name},placeSnapshot:state.activePlace?{id:state.activePlace.id,path:[...state.activePlace.path]}:null,placeResolution:null,workCategory:state.activeWorkCategory||'ゴキブリトラップ',stage:state.activeStage||'',comment:'',capturedAt:isoNow(),name:durable.name,type:durable.type,bytes:durable.bytes,captureSource:source};
  const learned=bestPlacementComment(photo);if(learned)photo={...photo,comment:learned,commentSource:'kv-placement'};
  await put('photos',photo);state.photos.push(photo);await learnPlacement(photo);await maybePromoteCover(photo);const cHash=photoCapability(photo).hash;await recordEvent(photo.placeSnapshot?'capture_resolved':'capture_unresolved',{photoId:photo.id,placeId:photo.placeSnapshot?.id||null,cHash,commentAutofilled:!!learned});
 }
 await refreshVisitHistory();$('#photoImport').value='';const stageText=state.activeStage?` / ${state.activeStage}`:'';setStatus(state.activePlace?`写真を場所付きで保存しました${stageText}`:`写真を保存しました${stageText}。場所は未設定のまま保持しています`);render();requestAnimationFrame(()=>document.querySelector('#photoGrid .photo-item:last-child')?.scrollIntoView({behavior:'smooth',block:'nearest'}))
}

async function resolvePhotoPlace(photoId,place){
 const index=state.photos.findIndex(p=>p.id===photoId);if(index<0)return;
 const photo=state.photos[index];if(!isUnresolved(photo))return;
 const resolvedAt=isoNow();const ageMs=Math.max(0,new Date(resolvedAt)-new Date(photo.capturedAt));
 const next={...photo,placeResolution:{id:place.id,path:[...place.path],resolvedAt}};await put('photos',next);state.photos[index]=next;await learnPlacement(next);await maybePromoteCover(next,'late-place-cHash');
 await recordEvent('photo_late_resolved',{photoId,placeId:place.id,ageMs});setStatus(`写真の場所を ${pathLabel(place.path)} と確認しました。撮影時未確認の履歴は保持しています`);
}

function toggleUnresolved(){state.showUnresolvedOnly=!state.showUnresolvedOnly;render()}
async function requestFinish(){
 if(!state.visit)return setStatus('まず撮影できます。現場名はあとで決められます');
 setStatus('現場を完了しています…');
 const filled=await applySafeKVCoverage();
 await completeAndOpenReport({autofill:filled});
}
async function completeAndOpenReport({autofill=null}={}){
 if(!state.visit)return setStatus('まず撮影できます');
 const unresolved=state.photos.filter(isUnresolved).length;
 const missingDetail=state.photos.filter(needsReportDetail).length;
 await finishVisit();
 await openReportPreview();
 const auto=autofill?autofill.stageFilled+autofill.commentFilled+autofill.coverFilled:0;
 const notes=[];if(auto)notes.push(`既知文脈から ${auto}件を自動補完`);if(unresolved)notes.push(`場所未確認 ${unresolved}枚`);if(missingDetail)notes.push(`未入力 ${missingDetail}枚`);
 setStatus(notes.length?`現場を完了して報告を開きました。${notes.join('、')}は報告側で後から直せます`:'現場を完了して報告を開きました');
}

async function finishVisit(){if(!state.visit)return setStatus('まず撮影できます');const unresolved=state.photos.filter(isUnresolved).length;state.visit.completedAt=isoNow();await put('visits',state.visit);await refreshVisitHistory();await recordEvent('visit_completed',{photoCount:state.photos.length,unresolvedCount:unresolved});setStatus(unresolved?`今日の現場を完了しました。未確認 ${unresolved}枚はそのまま保持しています`:'今日の現場を完了しました。もう帰れます');render()}

async function blobToDataURL(blob){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(blob)})}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function buildReportHTML(){
 if(!state.site||!state.visit)throw new Error('report context missing');
 const categoryGroups=new Map(WORK_CATEGORIES.map(x=>[x,new Map()]));const uncategorized=new Map();
 for(const p of placedPhotosForReport(state.photos)){const category=photoWorkCategory(p);const target=categoryGroups.get(category)||uncategorized;const label=pathLabel(effectivePlace(p));if(!target.has(label))target.set(label,[]);target.get(label).push(p)}
 const sections=[];
 for(const category of WORK_CATEGORIES){const groups=categoryGroups.get(category);if(!groups?.size)continue;const placeSections=[];for(const [label,photos] of groups){
  const cards=[];
  for(const p of photos){
   const provenance=p.placeSnapshot?'撮影時に確認':p.placeResolution?'後から確認':'未確認';
   const stage=photoStage(p)||'区分未設定';const comment=photoComment(p)||'報告文未入力';
   const capability=photoCapability(p);const imageData=await imageRecordToDataURL(p);
   const imageHTML=imageData?`<img src="${imageData}" alt="現場写真">`:`<div class="report-image-missing">画像を読み込めません<br><small>記録・コメントは保持されています</small></div>`;
   cards.push(`<article class="report-photo" data-photo-id="${esc(p.id)}" data-chash="${capability.hash}" data-placement="${esc(capability.placement)}">${imageHTML}<div><p class="report-stage">${esc(stage)}</p><h3>${esc(label)}</h3><p class="report-comment">${esc(comment)}</p><p class="report-provenance">${esc(provenance)} · ${esc(new Date(p.capturedAt).toLocaleString('ja-JP'))}</p><button type="button" class="report-photo-edit report-edit-control" data-photo-id="${esc(p.id)}">この写真を編集</button></div></article>`)
  }
  placeSections.push(`<section class="report-group"><h3>${esc(label)} <span>${photos.length}枚</span></h3><div class="report-photo-grid">${cards.join('')}</div></section>`)
 }sections.push(`<section class="report-work-section" data-work-category="${esc(category)}"><h2>${esc(categoryLabel(category))}</h2>${placeSections.join('')}</section>`)}
 if(uncategorized.size){const placeSections=[];for(const [label,photos] of uncategorized){const cards=[];for(const p of photos){const provenance=p.placeSnapshot?'撮影時に確認':p.placeResolution?'後から確認':'未確認';const stage=photoStage(p)||'区分未設定',comment=photoComment(p)||'報告文未入力',capability=photoCapability(p),imageData=await imageRecordToDataURL(p);const imageHTML=imageData?`<img src="${imageData}" alt="現場写真">`:`<div class="report-image-missing">画像を読み込めません<br><small>記録・コメントは保持されています</small></div>`;cards.push(`<article class="report-photo" data-photo-id="${esc(p.id)}" data-chash="${capability.hash}">${imageHTML}<div><p class="report-stage">${esc(stage)}</p><h3>${esc(label)}</h3><p class="report-comment">${esc(comment)}</p><p class="report-provenance">${esc(provenance)}</p><button type="button" class="report-photo-edit report-edit-control" data-photo-id="${esc(p.id)}">この写真を編集</button></div></article>`)}placeSections.push(`<section class="report-group"><h3>${esc(label)}</h3><div class="report-photo-grid">${cards.join('')}</div></section>`)}sections.push(`<section class="report-work-section uncategorized"><h2>未分類</h2>${placeSections.join('')}</section>`)}
 const displayName=state.site.placeholder?'現場未設定':state.site.name;
 const unresolved=state.photos.filter(isUnresolved).length;
 const coverData=await imageRecordToDataURL(state.site);
 const coverImage=coverData?`<img class="report-cover-image" src="${coverData}" alt="${esc(displayName)} 店舗外観">`:`<button type="button" id="quickCoverButton" class="report-cover-missing">店舗外観写真 未設定<br><small>タップして写真から入れる（次回から自動）</small></button>`;
 const customer=state.site.customerCompany||'';const address=state.site.address||'';const reportTitle=state.site.reportTitle||'作業報告書';const worker=state.visit.workerName||'';const workTitle=state.visit.workTitle||'';const basicWork=state.site.basicWork||'';const specialNotes=state.visit.specialNotes||'';
 const cover=`<section class="report-cover"><p class="report-cover-kicker">${esc(reportTitle)}</p><h1>${esc(displayName)}</h1>${address?`<p class="report-cover-address">${esc(address)}</p>`:''}${coverImage}<dl class="report-cover-meta"><div><dt>施工日時</dt><dd>${esc(state.visit.workDate)}</dd></div><div><dt>作業責任者</dt><dd>${esc(worker||'未入力')}</dd></div>${customer?`<div><dt>顧客・会社名</dt><dd>${esc(customer)}</dd></div>`:''}${workTitle?`<div><dt>今回の作業</dt><dd>${esc(workTitle)}</dd></div>`:''}</dl>${basicWork?`<section class="report-basic-work"><h2>基本作業</h2><p>${esc(basicWork)}</p></section>`:''}<footer>株式会社ガヤ・コーポレーション</footer></section>`;
 const notes=`<section class="report-special"><h2>5. 特別報告</h2><h3>【所見・備考】</h3><p>${esc(specialNotes||'特記事項なし')}</p><button type="button" class="report-meta-edit-inline report-edit-control">特別報告を編集</button></section>`;
 const reportBody=`<section class="report-body"><header><p class="eyebrow">FIELD REPORT</p><h1>${esc(workTitle||'作業報告')}</h1><p>${esc(displayName)} · ${esc(state.visit.workDate)} · 写真 ${state.photos.length}枚</p></header>${sections.join('')}${notes}</section>`;
 const body=`<article class="report-document">${cover}${reportBody}</article>`;
 const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(displayName)} Field REPORT</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif;color:#191a17;max-width:900px;margin:auto;padding:28px}.eyebrow{font-size:12px;font-weight:750;letter-spacing:.12em;color:#66685f}.report-cover{text-align:center;min-height:calc(100vh - 56px);display:flex;flex-direction:column;justify-content:flex-start}.report-cover-kicker{font-size:28px;font-weight:800;margin:18px 0 24px}.report-cover h1{font-size:32px;margin:0}.report-cover-address{margin:8px 0 24px}.report-cover-image,.report-cover-missing{width:100%;height:420px;object-fit:cover;background:#f0f0eb;border-radius:6px}.report-cover-missing{display:grid;place-items:center;color:#777}.report-cover-meta{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;text-align:left;margin:24px auto 12px;max-width:620px}.report-cover-meta div{display:grid;grid-template-columns:110px 1fr}.report-cover-meta dt{font-weight:700}.report-cover-meta dd{margin:0}.report-basic-work{text-align:left;max-width:620px;margin:12px auto}.report-basic-work h2{font-size:15px}.report-basic-work p{white-space:pre-wrap}.report-cover footer{margin-top:auto;padding-top:20px;font-size:18px;font-weight:800}.report-body>header{margin-bottom:28px}.report-body>header h1{font-size:30px}.report-work-section{margin:34px 0}.report-work-section>h2{border-bottom:2px solid #222;padding-bottom:9px}.report-group{margin:22px 0}.report-group h3{border-bottom:1px solid #ddd;padding-bottom:8px}.report-group h3 span{font-size:14px;color:#666}.report-photo-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.report-photo{break-inside:avoid;margin:0 0 10px}.report-photo img,.report-image-missing{width:100%;aspect-ratio:4/3;object-fit:cover;background:#f4f4ef;border-radius:4px}.report-image-missing{display:grid;place-items:center;text-align:center;color:#777}.report-image-missing small{font-size:11px}.report-photo h3{margin:9px 0 2px}.report-photo p{margin:0;color:#666}.report-comment{color:#333!important;white-space:pre-wrap}.report-provenance{font-size:11px}.report-edit-control{margin-top:10px;border:1px solid #bbb;border-radius:9px;background:#fff;padding:9px 12px;font:inherit;font-weight:700}.report-special{break-inside:avoid;margin-top:40px;border-top:2px solid #b33;padding-top:14px}.report-special p{white-space:pre-wrap;background:#fff6d9;padding:18px;min-height:80px}@media(max-width:620px){.report-photo-grid{grid-template-columns:1fr}.report-cover-image,.report-cover-missing{height:46vh}.report-cover-meta{grid-template-columns:1fr}}@media print{.report-edit-control{display:none!important}body{padding:0;max-width:none}.report-cover{height:100vh;min-height:0;break-after:page}.report-body{break-before:page}.report-photo{page-break-inside:avoid}.report-photo-grid{grid-template-columns:1fr 1fr}}</style></head><body>${body}</body></html>`;
 state.reportHTML=html;
 state.reportFilename=`Field-REPORT-${state.visit.workDate}-${safeFilename(displayName)}.html`;
 return {html,body,displayName,unresolved};
}

async function openReportPreview(){
 if(!state.site||!state.visit||!state.photos.length)return setStatus('報告にする写真がまだありません');
 setStatus('報告をまとめています…');
 try{
  const report=await buildReportHTML();
  $('#reportPreview').innerHTML=report.body;const quickCover=$('#reportPreview #quickCoverButton');if(quickCover)quickCover.onclick=()=>$('#quickCoverPhoto').click();$('#reportPreview').querySelectorAll('.report-photo-edit').forEach(b=>b.onclick=()=>editPhotoFromPreview(b.dataset.photoId));$('#reportPreview').querySelectorAll('.report-meta-edit-inline').forEach(b=>b.onclick=editReportMetaFromPreview);
  if(!$('#reportDialog').open)$('#reportDialog').showModal();
  const missingImages=$('#reportPreview').querySelectorAll('.report-image-missing').length;
  recordEvent('report_previewed',{photoCount:state.photos.length,unresolvedCount:report.unresolved,missingImageCount:missingImages});
  setStatus(missingImages?`報告を開きました。画像を読み込めない写真 ${missingImages}枚は記録を残したまま表示しています`:'報告をアプリ内で開きました');
 }catch(e){console.error(e);setStatus('報告を開けませんでした。写真はそのまま残っています')}
}

function capturedPhotoFiles(){
 const out=[];let seq=1;
 const coverReason=state.site?.coverPhotoSource?.reason||'';if(coverReason==='dedicated-cover-camera'){const cover=imageBlobFromRecord(state.site);if(cover){const ext=(cover.type||state.site.coverPhotoType||'image/jpeg').includes('png')?'png':(cover.type||state.site.coverPhotoType||'image/jpeg').includes('heic')?'heic':'jpg';out.push(new File([cover],`00-店舗外観.${ext}`,{type:cover.type||state.site.coverPhotoType||'image/jpeg'}))}}
 for(const p of state.photos){if(p.captureSource==='library')continue;const blob=imageBlobFromRecord(p);if(!blob)continue;const ext=(p.type||blob.type||'image/jpeg').includes('png')?'png':(p.type||blob.type||'image/jpeg').includes('heic')?'heic':'jpg';const name=`${String(seq).padStart(2,'0')}-${safeFilename(photoWorkCategory(p)||'現場')}-${safeFilename(pathLabel(effectivePlace(p)))}-${safeFilename(photoStage(p)||'未区分')}.${ext}`;out.push(new File([blob],name,{type:p.type||blob.type||'image/jpeg'}));seq++}return out
}
async function sharePhotosToLibrary(){
 try{
  const files=capturedPhotoFiles();if(!files.length)return setStatus('保存できる現場写真がありません');
  if(navigator.share&&(!navigator.canShare||navigator.canShare({files}))){await navigator.share({title:`Field REPORT 現場写真 ${files.length}枚`,text:'iPhoneの写真アプリへ残す場合は「画像を保存」を選んでください',files});await recordEvent('photos_shared_to_library',{count:files.length,method:'web-share'});setStatus(`${files.length}枚を共有メニューへ出しました。「画像を保存」で写真アプリへ入ります`);return}
  setStatus('このブラウザでは写真アプリへの一括共有に対応していません。Safariで開いてください')
 }catch(e){if(e?.name==='AbortError')return;console.error(e);setStatus('写真の共有を開けませんでした。アプリ内の写真は保持されています')}
}
async function editableReportHTML(report){const bundle=await import('./pc-bundle.js');return await bundle.editableReportHTML(report)}
async function generateEditableHTMLFile(){
 if(!state.site||!state.visit||!state.photos.length)throw new Error('report context missing');const report=await buildReportHTML();const html=await editableReportHTML(report);const display=state.site.placeholder?'現場未設定':state.site.name;const filename=`Field-REPORT-${state.visit.workDate}-${safeFilename(display)}-PC編集.html`;const file=new File([html],filename,{type:'text/html;charset=utf-8'});await recordEvent('editable_html_generated',{bytes:file.size,photoCount:state.photos.length});return file
}
async function shareEditableHTML(){
 try{
  const file=await generateEditableHTMLFile();
  if(navigator.share){
   if(!navigator.canShare||navigator.canShare({files:[file]})){await navigator.share({title:'Field REPORT PC編集用',text:'PCでブラウザを使って編集できます',files:[file]});await recordEvent('editable_html_shared',{method:'web-share-html',bytes:file.size});setStatus('PC編集用HTMLの共有メニューを開きました');return}
   const plainFile=new File([await file.text()],file.name,{type:'text/plain'});if(!navigator.canShare||navigator.canShare({files:[plainFile]})){await navigator.share({title:'Field REPORT PC編集用',text:'拡張子.htmlのPC編集用ファイルです',files:[plainFile]});await recordEvent('editable_html_shared',{method:'web-share-text-fallback',bytes:plainFile.size});setStatus('PC編集用HTMLの共有メニューを開きました');return}
  }
  downloadFile(file);await recordEvent('editable_html_shared',{method:'download-fallback',bytes:file.size});setStatus('PC編集用HTMLを保存しました。共有ボタンからPCへ送れます')
 }catch(e){if(e?.name==='AbortError')return;console.error(e);setStatus('PC編集用HTMLを作れませんでした。写真と報告内容は保持されています')}
}
async function drawableFromRecord(record){
 const blob=imageBlobFromRecord(record);if(!blob)return null;
 if('createImageBitmap'in window){try{return await createImageBitmap(blob)}catch{}}
 return await new Promise(resolve=>{const img=new Image();const url=URL.createObjectURL(blob);img.onload=()=>{URL.revokeObjectURL(url);resolve(img)};img.onerror=()=>{URL.revokeObjectURL(url);resolve(null)};img.src=url})
}
function newPDFCanvas(){const c=document.createElement('canvas');c.width=1240;c.height=1754;const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);return c}
function wrapCanvasLines(ctx,text,maxWidth,maxLines=999){const out=[];for(const para of String(text||'').split(/\n/)){if(!para){out.push('');continue}let line='';for(const ch of para){const next=line+ch;if(line&&ctx.measureText(next).width>maxWidth){out.push(line);line=ch;if(out.length>=maxLines)return out}else line=next}if(line)out.push(line);if(out.length>=maxLines)return out}return out}
function drawCanvasText(ctx,text,x,y,maxWidth,lineHeight,maxLines=999){const lines=wrapCanvasLines(ctx,text,maxWidth,maxLines);for(const line of lines){ctx.fillText(line,x,y);y+=lineHeight}return y}
function imageSize(img){return {w:img?.width||img?.naturalWidth||0,h:img?.height||img?.naturalHeight||0}}
function drawCanvasImage(ctx,img,x,y,w,h,mode='cover'){if(!img){ctx.fillStyle='#ecece6';ctx.fillRect(x,y,w,h);ctx.fillStyle='#777';ctx.font='500 28px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.textAlign='center';ctx.fillText('画像を読み込めません',x+w/2,y+h/2);ctx.textAlign='left';return}const s=imageSize(img);if(!s.w||!s.h)return;const scale=mode==='contain'?Math.min(w/s.w,h/s.h):Math.max(w/s.w,h/s.h);const dw=s.w*scale,dh=s.h*scale,dx=x+(w-dw)/2,dy=y+(h-dh)/2;ctx.save();ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();ctx.drawImage(img,dx,dy,dw,dh);ctx.restore()}
function drawPageFooter(ctx,pageNo,total){ctx.fillStyle='#777';ctx.font='500 22px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.textAlign='center';ctx.fillText(`${pageNo} / ${total}`,620,1710);ctx.textAlign='left'}
async function renderCoverPDFPage(){
 const c=newPDFCanvas(),ctx=c.getContext('2d');const name=state.site?.placeholder?'現場未設定':state.site?.name||'現場未設定';
 ctx.fillStyle='#111';ctx.textAlign='center';ctx.font='800 44px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText(state.site?.reportTitle||'作業報告書',620,105);ctx.font='800 62px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText(name,620,195);
 ctx.font='500 28px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillStyle='#555';if(state.site?.address)ctx.fillText(state.site.address,620,245);ctx.textAlign='left';
 const cover=await drawableFromRecord(state.site);if(cover)drawCanvasImage(ctx,cover,110,300,1020,670,'cover');else{ctx.fillStyle='#ecece6';ctx.fillRect(110,300,1020,670);ctx.fillStyle='#777';ctx.textAlign='center';ctx.font='500 34px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText('店舗外観写真 未設定',620,650);ctx.textAlign='left'}if(cover?.close)cover.close();
 const meta=[['施工日時',state.visit?.workDate||'未入力'],['作業責任者',state.visit?.workerName||'未入力'],['顧客・会社名',state.site?.customerCompany||''],['今回の作業',state.visit?.workTitle||'']].filter(x=>x[1]);let y=1035;for(const [k,v] of meta){ctx.fillStyle='#111';ctx.font='700 30px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText(k,130,y);ctx.font='500 30px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText(v,360,y);y+=54}
 if(state.site?.basicWork){ctx.fillStyle='#111';ctx.font='700 27px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText('基本作業',130,y+15);ctx.font='500 24px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillStyle='#333';drawCanvasText(ctx,state.site.basicWork,130,y+55,980,34,6)}
 ctx.textAlign='center';ctx.fillStyle='#111';ctx.font='800 28px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText('株式会社ガヤ・コーポレーション',620,1660);ctx.textAlign='left';return c
}
async function drawPDFPhotoCard(ctx,photo,x,y,w,h){
 ctx.strokeStyle='#d8d8d2';ctx.lineWidth=2;ctx.strokeRect(x,y,w,h);const imageH=360;const img=await drawableFromRecord(photo);if(img)drawCanvasImage(ctx,img,x,y,w,imageH,'cover');else drawCanvasImage(ctx,null,x,y,w,imageH);if(img?.close)img.close();
 const place=pathLabel(effectivePlace(photo)),stage=photoStage(photo)||'区分未設定',comment=photoComment(photo)||'報告文未入力';let ty=y+imageH+42;ctx.fillStyle='#111';ctx.font='800 28px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText(stage,x+22,ty);ty+=42;ctx.font='700 28px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText(place,x+22,ty);ty+=40;ctx.font='500 24px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillStyle='#333';drawCanvasText(ctx,comment,x+22,ty,w-44,31,4)
}
async function renderBodyPDFPages(){
 const pages=[];for(const category of WORK_CATEGORIES){const photos=placedPhotosForReport(state.photos).filter(p=>photoWorkCategory(p)===category);for(let offset=0;offset<photos.length;offset+=4){const c=newPDFCanvas(),ctx=c.getContext('2d');ctx.fillStyle='#111';ctx.font='800 42px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText(categoryLabel(category),70,85);ctx.font='500 24px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillStyle='#666';ctx.fillText(`${state.site?.name||'現場'} ・ ${state.visit?.workDate||''}`,70,125);const subset=photos.slice(offset,offset+4);for(let i=0;i<subset.length;i++){const col=i%2,row=Math.floor(i/2);await drawPDFPhotoCard(ctx,subset[i],70+col*570,170+row*730,530,680)}pages.push(c)}}
 if(state.visit?.specialNotes){const c=newPDFCanvas(),ctx=c.getContext('2d');ctx.fillStyle='#b33';ctx.font='800 44px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText('5. 特別報告',80,120);ctx.fillStyle='#111';ctx.font='700 34px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';ctx.fillText('【所見・備考】',80,190);ctx.fillStyle='#fff4cf';ctx.fillRect(80,240,1080,1180);ctx.fillStyle='#222';ctx.font='500 30px -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif';drawCanvasText(ctx,state.visit.specialNotes,120,300,1000,44,24);pages.push(c)}return pages
}

async function canvasJpegBytes(canvas){const blob=await new Promise((res,rej)=>canvas.toBlob(b=>b?res(b):rej(new Error('JPEG conversion failed')),'image/jpeg',0.9));return {bytes:new Uint8Array(await blob.arrayBuffer()),width:canvas.width,height:canvas.height}}
function buildRasterPDF(images){
 const enc=new TextEncoder(),chunks=[],offsets=[0];let offset=0;const push=x=>{const b=typeof x==='string'?enc.encode(x):x;chunks.push(b);offset+=b.length};const obj=(n,body)=>{offsets[n]=offset;push(`${n} 0 obj\n`);push(body);push(`\nendobj\n`)};push('%PDF-1.4\n%FIELDREPORT\n');const count=images.length,objCount=2+count*3;obj(1,'<< /Type /Catalog /Pages 2 0 R >>');const kids=images.map((_,i)=>`${3+i*3} 0 R`).join(' ');obj(2,`<< /Type /Pages /Kids [${kids}] /Count ${count} >>`);
 for(let i=0;i<count;i++){const page=3+i*3,imgObj=page+1,contentObj=page+2,image=images[i];obj(page,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im1 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);offsets[imgObj]=offset;push(`${imgObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`);push(image.bytes);push(`\nendstream\nendobj\n`);const stream='q 595.28 0 0 841.89 0 0 cm /Im1 Do Q';obj(contentObj,`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)}
 const xref=offset;push(`xref\n0 ${objCount+1}\n0000000000 65535 f \n`);for(let i=1;i<=objCount;i++)push(`${String(offsets[i]).padStart(10,'0')} 00000 n \n`);push(`trailer\n<< /Size ${objCount+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);return new Blob(chunks,{type:'application/pdf'})
}
async function generatePDFFile(){
 if(!state.site||!state.visit||!state.photos.length)throw new Error('report context missing');setStatus('PDFを作っています…');await applySafeKVCoverage();const canvases=[await renderCoverPDFPage(),...await renderBodyPDFPages()];const images=[];for(const c of canvases)images.push(await canvasJpegBytes(c));canvases.forEach(c=>{c.width=1;c.height=1});const blob=buildRasterPDF(images);const filename=`Field-REPORT-${state.visit.workDate}-${safeFilename(state.site.placeholder?'現場未設定':state.site.name)}.pdf`;const file=new File([blob],filename,{type:'application/pdf'});await recordEvent('pdf_generated',{pageCount:images.length,bytes:file.size});return file
}
async function shareReport(){
 try{const file=await generatePDFFile();if(navigator.share&&(!navigator.canShare||navigator.canShare({files:[file]}))){await navigator.share({title:'Field REPORT',files:[file]});await recordEvent('report_shared',{method:'pdf-web-share',bytes:file.size});setStatus('PDFの共有メニューを開きました');return}downloadFile(file);await recordEvent('report_shared',{method:'pdf-download-fallback',bytes:file.size});setStatus('PDFを保存しました')}catch(e){if(e?.name==='AbortError')return;console.error(e);setStatus('PDFを作れませんでした。写真と報告内容は保持されています')}
}
function downloadFile(file){const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=file.name;a.target='_blank';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)}
async function savePDFReport(){try{const file=await generatePDFFile();downloadFile(file);setStatus(`PDFを作成しました（${Math.max(1,Math.round(file.size/1024))}KB）`)}catch(e){console.error(e);setStatus('PDFを作れませんでした。写真と報告内容は保持されています')}}

async function semanticStagnationSummary(){
 const now=Date.now();const unresolved=state.photos.filter(isUnresolved);const events=await getAll('events');return {unresolvedCount:unresolved.length,unresolvedAgeMs:unresolved.reduce((n,p)=>n+Math.max(0,now-new Date(p.capturedAt).getTime()),0),lateResolutionCount:events.filter(e=>e.type==='photo_late_resolved').length,eventCount:events.length,blockedCaptureCount:0};
}

const JOURNEY_ORDER=['site','place','stage','photo','report'];
function currentJourneyStep(){
 if(!state.site||state.site.placeholder)return 'site';
 if(state.visit?.completedAt)return 'report';
 if(!state.activePlace)return 'place';
 if(!state.activeStage)return 'stage';
 return 'photo';
}
function journeyModel(){
 const step=currentJourneyStep();
 const hasPhotos=state.photos.length>0;
 if(step==='site')return {step,title:'現場を開く',hint:'今日の現場を選びます。現場名がまだ分からなければ、保存済み写真の取り込みを先にしても大丈夫です。',primary:'現場を開く',secondary:'現場名はあとで → 写真を選ぶ'};
 if(step==='place')return {step,title:'場所を1回選ぶ',hint:'いま撮る場所を選びます。移動するまでそのまま保持します。',primary:'場所を選ぶ',secondary:'場所未設定で写真を選ぶ'};
 if(step==='stage')return {step,title:'区分を1回選ぶ',hint:'施工前 / 作業中 / 施工後 / 確認点。変わるまで選び直しません。',primary:'区分を選ぶ',secondary:'区分未設定で写真を選ぶ'};
 if(step==='report')return {step,title:'報告を確認する',hint:'現場は完了済みです。報告を確認してPDFまたはPC編集HTMLへ進めます。',primary:'報告を見る',secondary:''};
 return {step,title:hasPhotos?'次の写真を追加する':'写真を取り込む',hint:hasPhotos?`現在 ${state.photos.length}枚。撮影を続けるなら写真を追加、終わったら報告へ進みます。`:'iPhone標準カメラで撮影済みの写真を選びます。原本は写真アプリに残ります。',primary:hasPhotos?'写真を追加':'写真を選ぶ',secondary:hasPhotos?'撮影終了 → 報告':''};
}
function focusJourneyTarget(selector){const el=$(selector);if(!el)return;el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('journey-pulse');setTimeout(()=>el.classList.remove('journey-pulse'),900)}
function runJourneyPrimaryAction(){
 const m=journeyModel();recordEvent('hat_primary_action',{step:m.step,action:m.primary,dwellMs:Math.max(0,Date.now()-state.hatEnteredAt)});
 if(m.step==='site')return $('#startSiteButton').click();
 if(m.step==='place')return $('#placeButton').click();
 if(m.step==='stage')return focusJourneyTarget('#stageCard');
 if(m.step==='photo')return $('#photoImport').click();
 if(m.step==='report')return openReportPreview();
}
function runJourneySecondaryAction(){
 const m=journeyModel();recordEvent('hat_secondary_action',{step:m.step,action:m.secondary,dwellMs:Math.max(0,Date.now()-state.hatEnteredAt)});
 if(m.step==='site'||m.step==='place'||m.step==='stage')return $('#photoImport').click();
 if(m.step==='photo'&&state.photos.length)return requestFinish();
}
function renderJourney(){
 const m=journeyModel(),idx=JOURNEY_ORDER.indexOf(m.step);$('#journeyTitle').textContent=m.title;$('#journeyHint').textContent=m.hint;$('#journeyProgress').textContent=`${idx+1} / ${JOURNEY_ORDER.length}`;$('#journeyPrimaryAction').textContent=m.primary;const secondary=$('#journeySecondaryAction');secondary.textContent=m.secondary;secondary.hidden=!m.secondary;
 document.querySelectorAll('[data-journey-step]').forEach((el,i)=>{el.classList.toggle('done',i<idx);el.classList.toggle('active',i===idx);el.setAttribute('aria-current',i===idx?'step':'false')});
 observeJourneyState(m.step);
}
function observeJourneyState(step){
 const now=Date.now();if(state.hatStep===step)return;
 if(state.hatStep&&state.db)recordEvent('hat_state_exit',{step:state.hatStep,dwellMs:Math.max(0,now-state.hatEnteredAt),photoCount:state.photos.length}).catch(()=>{});
 state.hatStep=step;state.hatEnteredAt=now;
 if(state.db)recordEvent('hat_state_enter',{step,photoCount:state.photos.length,hasPlace:!!state.activePlace,stage:state.activeStage||null,workCategory:state.activeWorkCategory||null}).catch(()=>{});
}
function humanControlKey(el){
 if(el.id)return `id:${el.id}`;const target=el.getAttribute?.('for');if(target)return `for:${target}`;
 for(const cls of ['quick-place','work-category-choice','stage-choice','preset-choice','site-choice','place-choice','photo-detail-action','photo-action','photo-cover-action','manual-link'])if(el.classList?.contains(cls))return `class:${cls}`;
 if(el.tagName==='SUMMARY')return 'summary:utility-menu';return `tag:${String(el.tagName||'unknown').toLowerCase()}`;
}
function observeHumanAction(event){
 const el=event.target?.closest?.('button,a,label,summary');if(!el||!state.db)return;
 recordEvent('hat_action',{step:currentJourneyStep(),control:humanControlKey(el),dwellMs:Math.max(0,Date.now()-state.hatEnteredAt)}).catch(()=>{});
}
async function humanAttentionSummary(){
 const events=(await getAll('events')).filter(e=>String(e.type||'').startsWith('hat_')&&e.hatSessionId===state.hatSessionId).sort((a,b)=>(a.hatSequence||0)-(b.hatSequence||0));
 const dwellByStep={},actions={},enters=[];let backtracks=0;
 for(const e of events){
  if(e.type==='hat_state_exit'&&e.step)dwellByStep[e.step]=(dwellByStep[e.step]||0)+Math.max(0,Number(e.dwellMs)||0);
  if(e.type==='hat_action'&&e.control)actions[e.control]=(actions[e.control]||0)+1;
  if(e.type==='hat_state_enter'&&e.step){const prev=enters.at(-1);if(prev&&JOURNEY_ORDER.indexOf(e.step)<JOURNEY_ORDER.indexOf(prev))backtracks++;enters.push(e.step)}
 }
 const slowestStep=Object.entries(dwellByStep).sort((a,b)=>b[1]-a[1])[0]||null;
 const repeatedActions=Object.entries(actions).filter(([,n])=>n>1).sort((a,b)=>b[1]-a[1]);
 return {schema:'field-report.human-attention-summary/v0',eventCount:events.length,dwellByStep,slowestStep:slowestStep?{step:slowestStep[0],dwellMs:slowestStep[1]}:null,backtrackCount:backtracks,repeatedActions:repeatedActions.map(([control,count])=>({control,count})),currentStep:currentJourneyStep(),observationKind:state.hatOrigin,mutationAuthority:'NONE',privacy:'control-keys-only; no typed report text or site/place labels'};
}

function renderSites(){getAll('sites').then(sites=>{$('#siteList').innerHTML='';sites.filter(s=>!s.placeholder).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).forEach(s=>{const b=document.createElement('button');b.type='button';b.className='site-choice';b.innerHTML=`<strong>${esc(s.placeholder?'現場未設定':s.name)}</strong><small>覚えている場所 ${s.places.length}件</small>`;b.onclick=()=>selectSite(s.id);$('#siteList').append(b)});if(!sites.some(s=>!s.placeholder))$('#siteList').innerHTML='<p class="empty">保存済みの現場はまだありません。</p>'})}
function renderPlaces(){const root=$('#placeList');root.innerHTML='';if(!state.site){root.innerHTML='<p class="empty">場所はあとで決められます。まず撮影できます。</p>';return}state.site.places.forEach(p=>{const b=document.createElement('button');b.type='button';b.className='place-choice';b.textContent=pathLabel(p.path);b.onclick=()=>selectPlace(p.id);root.append(b)});if(!state.site.places.length)root.innerHTML='<p class="empty">場所はまだありません。必要になった場所だけ追加してください。</p>'}
function nextStepText(){
 if(!state.site||state.site.placeholder)return 'まず現場を開く。現場名がまだ分からなければ保存済み写真の取り込みを先にできます。';
 if(state.visit?.completedAt)return '今日の現場は完了です。報告を確認して共有できます。';
 if(!state.activePlace)return '場所を1回選びます。移動するまで保持されます。';
 if(!state.activeStage)return '施工前 / 作業中 / 施工後 / 確認点を1回選びます。';
 const unresolved=state.photos.filter(isUnresolved).length;
 if(unresolved)return `撮影を続けられます。場所未確認 ${unresolved}枚は後から確認できます。`;
 if(!state.photos.length)return '標準カメラで撮影済みの写真を選びます。原本は写真アプリに残ります。';
 return '写真を追加するか、撮影が終わったら報告へ進みます。';
}

function render(){
 const hasNamedSite=!!state.site&&!state.site.placeholder;
 const stage=!hasNamedSite?'site':state.activePlace?'capture':'place';
 document.body.dataset.stage=stage;
 const displaySite=hasNamedSite?state.site.name:'今日の現場';
 $('#siteTitle').textContent=displaySite;
 $('#siteButton').hidden=!hasNamedSite;
 $('#siteButton').textContent='現場を切り替える';
 $('#startCard').hidden=hasNamedSite;
 $('#placeCard').hidden=!hasNamedSite;
 $('#workCategoryCard').hidden=!hasNamedSite;
 $('#stageCard').hidden=!hasNamedSite;
 $('#mainCaptureZone').hidden=stage==='site';
 $('#recordCard').hidden=!state.photos.length;
 $('#finishZone').hidden=!state.photos.length;
 $('#siteSubtitle').textContent=stage==='site'?'最初に、今日どこで仕事するかだけ決めます。':state.visit?`${state.visit.workDate} / ${state.visit.completedAt?'完了':'作業中'}`:'撮った時に分かっていた意味を、そのまま残す。';
 const coverCard=$('#coverCaptureCard'),coverThumb=$('#coverCaptureThumb'),coverButton=$('#coverCaptureButton');coverCard.hidden=!hasNamedSite;if(state.coverThumbURL){URL.revokeObjectURL(state.coverThumbURL);state.coverThumbURL=null}const coverBlob=hasNamedSite?imageBlobFromRecord(state.site):null;if(coverBlob){state.coverThumbURL=URL.createObjectURL(coverBlob);coverThumb.src=state.coverThumbURL;coverThumb.hidden=false;coverButton.textContent='外観を選び直す';$('#coverCaptureTitle').textContent='店舗外観 ✓';$('#coverCaptureHint').textContent='表紙として保存済み。原本は写真アプリにあります。作業写真とは別です。'}else{coverThumb.removeAttribute('src');coverThumb.hidden=true;coverButton.textContent='🏠 外観を選ぶ';$('#coverCaptureTitle').textContent='店舗外観';$('#coverCaptureHint').textContent='iPhone標準カメラで撮影済みの外観を選びます。原本は写真アプリに残ります。'}
 $('#currentPlace').textContent=state.activePlace?pathLabel(state.activePlace.path):'どこで撮る？';
 $('#placeHint').textContent=state.activePlace?'この場所を写真へ記録します。':'分かる範囲だけで大丈夫。分からなくても撮影できます。';
 renderQuickPlaces();
 $('#placeButton').hidden=false;
 $('#placeButton').textContent=state.site?.places?.length?'＋ 場所':'場所を決める';
 const workIndex=Math.max(0,WORK_CATEGORIES.indexOf(state.activeWorkCategory));$('#currentWorkCategory').textContent=`${workIndex+1} / 5　${state.activeWorkCategory}`;document.querySelectorAll('.work-category-choice').forEach(button=>button.classList.toggle('active',button.dataset.workCategory===state.activeWorkCategory));const nextCategory=WORK_CATEGORIES[workIndex+1];$('#nextWorkCategoryButton').hidden=!nextCategory;$('#nextWorkCategoryButton').textContent=nextCategory?`次の施工へ → ${nextCategory}`:'これが最後の施工です';
 $('#currentStage').textContent=state.activeStage||'区分未設定';
 document.querySelectorAll('.stage-choice').forEach(button=>button.classList.toggle('active',button.dataset.stage===state.activeStage));
 $('#stageHint').textContent=state.activeStage?`${state.activeStage} を次の写真へ引き継ぎます。変わった時だけ押し直します。`:'区分は後からでも付けられます。今分かるなら一度だけ選んでください。';
 $('#moveButton').hidden=true;
 const safeImportLabel=$('#safeImportLabel');if(safeImportLabel)safeImportLabel.textContent=stage==='place'?'保存済み写真を選ぶ（場所未設定OK）':'写真を選ぶ（原本保存済み）';
 const unresolved=state.photos.filter(isUnresolved).length;
 $('#photoCount').textContent=state.photos.length;
 $('#unresolvedButton').textContent=state.showUnresolvedOnly?'すべて見る':`未確認 ${unresolved}`;
 $('#unresolvedButton').disabled=!unresolved && !state.showUnresolvedOnly;
 $('#unresolvedButton').classList.toggle('active',state.showUnresolvedOnly);
 const grid=$('#photoGrid');grid.innerHTML='';const visible=state.showUnresolvedOnly?state.photos.filter(isUnresolved):state.photos;$('#emptyPhotos').hidden=visible.length>0;$('#emptyPhotos').textContent=state.showUnresolvedOnly?'場所未確認の写真はありません。':'まだ写真はありません。';visible.forEach(p=>{const node=$('#photoTemplate').content.cloneNode(true);const card=node.querySelector('.photo-item');const capability=photoCapability(p);if(card){card.dataset.chash=capability.hash;card.dataset.placement=capability.placement}const img=node.querySelector('img');const url=imageRecordObjectURL(p);if(url){img.src=url;img.onload=()=>URL.revokeObjectURL(url);img.onerror=()=>{URL.revokeObjectURL(url);imageRecordToDataURL(p).then(data=>{if(data){img.onerror=()=>{img.removeAttribute('src');img.alt='画像を読み込めません';img.classList.add('image-missing')};img.src=data}else{img.removeAttribute('src');img.alt='画像を読み込めません';img.classList.add('image-missing')}})}}else{img.removeAttribute('src');img.alt='画像を読み込めません';img.classList.add('image-missing')}node.querySelector('.photo-work-category').textContent=categoryLabel(photoWorkCategory(p));node.querySelector('.photo-place').textContent=pathLabel(effectivePlace(p));node.querySelector('.photo-time').textContent=new Date(p.capturedAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});node.querySelector('.photo-stage').textContent=photoStage(p)||'区分未設定';node.querySelector('.photo-comment').textContent=photoComment(p)||'報告文未入力';const detailAction=node.querySelector('.photo-detail-action');detailAction.onclick=()=>openPhotoDetail(p.id);const coverAction=node.querySelector('.photo-cover-action');const isCurrentCover=state.site?.coverPhotoSource?.photoId===p.id;coverAction.hidden=!isCurrentCover&&!isCoverCandidate(p);coverAction.textContent=isCurrentCover?'表紙 ✓':'表紙';coverAction.onclick=()=>confirmCoverPhoto(p.id,false);const provenance=node.querySelector('.photo-provenance');const action=node.querySelector('.photo-action');if(p.placeSnapshot){provenance.textContent='撮影時に場所確認';action.hidden=true}else if(p.placeResolution){provenance.textContent='撮影時未確認 → 後から確認';action.hidden=true}else{provenance.textContent='場所はまだ未確認';action.hidden=false;action.onclick=()=>openPlaceDialog(p.id)}grid.append(node)});
 const completed=!!state.visit?.completedAt;
 $('#finishButton').hidden=completed;
 $('#finishButton').disabled=!state.visit||completed;
 $('#reportButton').disabled=!state.visit||!state.photos.length;
 $('#reportButton').textContent=completed?'報告を見る':'途中の報告を見る';
 $('#reportButton').classList.toggle('primary',completed);
 $('#reportButton').classList.toggle('secondary',!completed);
 const savePhotosButton=$('#savePhotosButton');if(savePhotosButton){const savable=capturedPhotoFiles().length;savePhotosButton.textContent=savable?`写真アプリへ保存（${savable}枚）`:'写真アプリへ保存';savePhotosButton.disabled=!savable}
 const standalone=window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true;
 $('#installHelpButton').hidden=standalone;
 renderJourney();renderVisitRecovery();
 $('#nextStep').textContent=nextStepText();
}
function setStatus(s){$('#status').textContent=s}

async function runSelfTest(){
 // Shutter first: no site setup is allowed to block evidence capture.
 if(withSiteSeed({name:'ハイム大川',address:''}).address!=='東京都渋谷区本町6-1-22 ハイム大川103')throw new Error('site KV seed failed');
 const pixel=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAAwAAf4CBmUAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const first=new File([pixel],'selftest-a.png',{type:'image/png'});await captureFiles([first],{source:'library'});if(state.photos[0].captureSource!=='library')throw new Error('safe import source failed');if(!$('#journeyRail')||!$('#journeyPrimaryAction')||JOURNEY_ORDER.length!==5)throw new Error('human journey rail missing');const hat0=await humanAttentionSummary();if(hat0.mutationAuthority!=='NONE'||!hat0.privacy.includes('control-keys-only'))throw new Error('HAT privacy/authority contract failed');if(hat0.observationKind!=='SYNTHETIC_SELFTEST')throw new Error('HAT synthetic provenance failed');
 if(!state.site?.placeholder||state.photos.length!==1||!isUnresolved(state.photos[0]))throw new Error('shutter-first failed');
 const originalSiteId=state.site.id;state.site={...state.site,name:'SELFTEST現場',placeholder:false,updatedAt:isoNow()};await put('sites',state.site);if(state.site.id!==originalSiteId)throw new Error('site identity changed while naming');
 const place={id:uuid(),path:['1F','厨房'],createdAt:isoNow()};state.site.places.push(place);await put('sites',state.site);state.activePlace=place;state.activeStage='施工前';
 const second=new File([pixel],'selftest-b.png',{type:'image/png'});await captureFiles([second],{source:'library'});if(pathLabel(state.photos[1].placeSnapshot?.path)!=='1F・厨房')throw new Error('semantic capture failed');if(photoStage(state.photos[1])!=='施工前')throw new Error('capture stage inheritance failed');
 openPhotoDetail(state.photos[1].id);$('#photoCommentInput').value='異常は確認されませんでした';await savePhotoDetail();if(photoComment(state.photos[1])!=='異常は確認されませんでした')throw new Error('photo report text save failed');if(!siteKV().recentComments.includes('異常は確認されませんでした'))throw new Error('KV comment cache failed');if(photoCapability(state.photos[1]).hash!==photoCapability(state.photos[1]).hash)throw new Error('cHash unstable');
 // Resolve the first photo later without rewriting capture-time truth.
 await resolvePhotoPlace(state.photos[0].id,place);if(state.photos[0].placeSnapshot!==null||pathLabel(state.photos[0].placeResolution?.path)!=='1F・厨房')throw new Error('late resolution rewrote capture truth');
 const place2={id:uuid(),path:['1F','シンク'],createdAt:isoNow()};state.site.places.push(place2);await put('sites',state.site);await selectQuickPlace(place2.id);if(pathLabel(state.activePlace?.path)!=='1F・シンク')throw new Error('one-tap place transition failed');await selectQuickPlace(place.id);if(pathLabel(state.activePlace?.path)!=='1F・厨房')throw new Error('one-tap place return failed');await clearActivePlace();await applyPlace(place);state.activeStage='施工前';state.visit={...state.visit,currentStage:'施工前'};await put('visits',state.visit);const sameVisitId=state.visit.id;await startOrResumeVisit(state.site);if(state.visit.id!==sameVisitId||pathLabel(state.activePlace?.path)!=='1F・厨房'||state.activeStage!=='施工前')throw new Error('same-visit context restore failed');await clearActivePlace();const third=new File([pixel],'selftest-c.png',{type:'image/png'});await captureFiles([third],{source:'library'});if(!isUnresolved(state.photos[2]))throw new Error('unresolved capture failed');const renderedIds=[...document.querySelectorAll('#photoGrid .photo-item')].map(x=>x.dataset.chash);const expectedIds=state.photos.map(p=>photoCapability(p).hash);if(renderedIds.join('|')!==expectedIds.join('|'))throw new Error('photo chronological order failed');$('#photoCommentInput').value='テスト定型文';await saveCurrentCommentAsPreset();if(!siteKV().customPresets.includes('テスト定型文'))throw new Error('custom preset save failed');
 // Simulate a legacy iOS/WKWebView record whose image payload can no longer be read.
 const degraded={...state.photos[2],bytes:null,blob:null};await put('photos',degraded);state.photos[2]=degraded;
 const summary=await semanticStagnationSummary();if(summary.unresolvedCount!==1||summary.lateResolutionCount<1||summary.blockedCaptureCount!==0)throw new Error('stagnation ledger mismatch');if(capturedPhotoFiles().length!==0)throw new Error('library originals should not be duplicated');const placed=placedPhotosForReport(state.photos.slice(0,2));if(placed[0].id!==state.photos[1].id)throw new Error('cHash placement failed');
 state.activeStage='作業中';state.activeWorkCategory='ネズミ粉剤';state.visit={...state.visit,currentStage:'作業中',currentWorkCategory:'ネズミ粉剤'};await put('visits',state.visit);await updateSiteKV(kv=>({...kv,lastWorkTitle:'防鼠防虫作業'}));const firstVisit=state.visit.id;await requestFinish();if($('#finishDialog').open)throw new Error('finish dialog blocked mid-work completion');if(!state.visit.completedAt)throw new Error('completion failed');if(!$('#reportDialog').open||$('#reportPreview').querySelectorAll('.report-photo').length!==3||!$('#reportPreview').querySelector('.report-cover')||$('#reportPreview').querySelectorAll('.report-image-missing').length!==1)throw new Error('in-app degraded-image report preview failed');if($('#reportPreview').querySelectorAll('.report-photo-edit').length!==3||!$('#reportPreview').querySelector('.report-meta-edit-inline'))throw new Error('report in-app edit controls missing');const sectionLabels=[...$('#reportPreview').querySelectorAll('.report-work-section>h2')].map(x=>x.textContent);if(sectionLabels[0]!=='1. ゴキブリトラップ')throw new Error('report work order failed');const pdf=await generatePDFFile();const head=new TextDecoder().decode(new Uint8Array(await pdf.arrayBuffer()).slice(0,5));if(head!=='%PDF-'||pdf.size<1000)throw new Error('real PDF generation failed');const editable=await generateEditableHTMLFile();const editableText=await editable.text();if(!editable.type.startsWith('text/html')||editable.size<1000||!editable.name.endsWith('-PC編集.html')||!editableText.includes('Field REPORT｜PC編集モード')||!editableText.includes('saveEditedHTMLButton')||!editableText.includes('pcPrintButton')||!editableText.includes('replaceImage')||!editableText.includes('data:image/'))throw new Error('editable HTML bundle failed');$('#reportDialog').close();await startOrResumeVisit(state.site,{forceNew:true});if(state.visit.id===firstVisit)throw new Error('new visit not created');if(!state.visitHistory.some(x=>x.visit.id===firstVisit&&x.photoCount===3))throw new Error('completed history not retained');if(!state.site.places.some(p=>pathLabel(p.path)==='1F・厨房'))throw new Error('site memory lost');if(state.activePlace!==null)throw new Error('old authority restored');if(siteKV().lastWorkTitle!=='防鼠防虫作業'||!siteKV().recentComments.includes('異常は確認されませんでした'))throw new Error('KV cache lost');if(siteKV().placementCounts['ゴキブリトラップ|1F・厨房|施工前']!==1)throw new Error('cHash placement double-counted');openReportMeta();if($('#reportWorkTitle').value!==''||$('#reportKVHints').hidden||!$('#reportKVHints').textContent.includes('防鼠防虫作業'))throw new Error('KV suggestion authority boundary failed');closeReportMeta();
 document.body.dataset.selftest='pass';document.body.dataset.unresolved='1';setStatus('SELFTEST PASS');
}

init().then(()=>{if(new URLSearchParams(location.search).get('selftest')==='1')return runSelfTest()}).catch(e=>{console.error(e);document.body.dataset.selftest='fail';setStatus('初期化に失敗しました。Safariのストレージ設定を確認してください')});
