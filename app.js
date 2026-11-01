'use strict';
const DB_NAME='field-report-pilot-v1';
const DB_VERSION=2;
const $=s=>document.querySelector(s);
const state={db:null,site:null,visit:null,activePlace:null,activeStage:'',photos:[],resolvingPhotoId:null,editingPhotoId:null,pendingCoverPhoto:null,coverPreviewURL:null,showUnresolvedOnly:false,reportHTML:null,reportFilename:null};

const BUILTIN_PRESETS=[
 ['異常なし','異常は確認されませんでした'],
 ['喫食なし','喫食はありませんでした'],
 ['捕獲・目撃なし','捕獲・目撃はありませんでした'],
 ['侵入痕跡なし','侵入痕跡は確認されませんでした']
];
const STAGE_ORDER=new Map([['施工前',0],['作業中',1],['施工後',2],['確認点',3],['',9]]);
function siteKV(site=state.site){const kv=site?.kvCache||{};return {lastWorkTitle:String(kv.lastWorkTitle||''),recentComments:Array.isArray(kv.recentComments)?kv.recentComments.filter(Boolean).slice(0,8):[],placementCounts:kv.placementCounts&&typeof kv.placementCounts==='object'?kv.placementCounts:{},placementByPhoto:kv.placementByPhoto&&typeof kv.placementByPhoto==='object'?kv.placementByPhoto:{}}}
function fastHash(input){let h=2166136261;for(const ch of String(input)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}return (h>>>0).toString(16).padStart(8,'0')}
function photoCapability(photo){
 const place=pathLabel(effectivePlace(photo));const stage=photoStage(photo).trim();const comment=photoComment(photo).trim();const readable=!!imageBlobFromRecord(photo);
 const provenance=photo.placeSnapshot?'capture':photo.placeResolution?'late':'unknown';
 const roles=[stage||'stage-unknown',comment?'commented':'comment-missing',readable?'image-readable':'image-missing',provenance];
 const placement=`${place}|${stage||'未区分'}`;return {hash:fastHash(`${placement}|${roles.join('|')}`),place,stage,roles,placement,readable};
}
function placedPhotosForReport(photos){const firstSeen=new Map();photos.forEach((p,i)=>{const place=photoCapability(p).place;if(!firstSeen.has(place))firstSeen.set(place,i)});return photos.slice().sort((a,b)=>{const ca=photoCapability(a),cb=photoCapability(b);const pa=firstSeen.get(ca.place)??9999,pb=firstSeen.get(cb.place)??9999;if(pa!==pb)return pa-pb;const sa=STAGE_ORDER.get(ca.stage)??8,sb=STAGE_ORDER.get(cb.stage)??8;if(sa!==sb)return sa-sb;return String(a.capturedAt).localeCompare(String(b.capturedAt))})}
async function updateSiteKV(mutator){if(!state.site||state.site.placeholder)return;const next=mutator(siteKV(state.site));state.site={...state.site,kvCache:next,updatedAt:isoNow()};await put('sites',state.site)}
async function learnComment(comment){const value=String(comment||'').trim();if(!value)return;await updateSiteKV(kv=>({...kv,recentComments:[value,...kv.recentComments.filter(x=>x!==value)].slice(0,8)}))}
async function learnPlacement(photo){if(!state.site||state.site.placeholder)return;const c=photoCapability(photo);await updateSiteKV(kv=>{const counts={...kv.placementCounts};const byPhoto={...kv.placementByPhoto};const old=byPhoto[photo.id]||'';const next=(c.place==='場所未設定'||!c.stage)?'':c.placement;if(old===next)return kv;if(old){counts[old]=Math.max(0,(counts[old]||1)-1);if(!counts[old])delete counts[old]}if(next){counts[next]=(counts[next]||0)+1;byPhoto[photo.id]=next}else delete byPhoto[photo.id];return {...kv,placementCounts:counts,placementByPhoto:byPhoto}})}

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
async function recordEvent(type,detail={}){if(!state.db)return;try{await put('events',{id:uuid(),type,at:isoNow(),siteId:state.site?.id||null,visitId:state.visit?.id||null,...detail})}catch(e){console.warn('ledger event failed',type,e)}}

async function init(){
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
  const site={id:uuid(),name:'現場未設定',placeholder:true,places:[],customerCompany:'',address:'',reportTitle:'作業報告書',basicWork:'',coverPhotoBlob:null,kvCache:{lastWorkTitle:'',recentComments:[],placementCounts:{},placementByPhoto:{}},createdAt:isoNow(),updatedAt:isoNow()};
  await put('sites',site);state.site=site;localStorage.setItem('field-report-last-site',site.id);await recordEvent('site_auto_created');
 }
 await startOrResumeVisit(state.site);
}

async function startOrResumeVisit(site){
 state.site=site; localStorage.setItem('field-report-last-site',site.id);
 const visits=(await getAll('visits')).filter(v=>v.siteId===site.id).sort((a,b)=>b.startedAt.localeCompare(a.startedAt));
 let v=visits.find(v=>!v.completedAt && v.workDate===localDay());
 if(!v){v={id:uuid(),siteId:site.id,workDate:localDay(),workerName:localStorage.getItem('field-report-last-worker')||'',workTitle:'',specialNotes:'',startedAt:isoNow(),completedAt:null};await put('visits',v);state.visit=v;await recordEvent('visit_started')}else state.visit=v;
 state.activePlace=null;state.resolvingPhotoId=null;state.showUnresolvedOnly=false;
 state.photos=(await getByIndex('photos','visitId',v.id)).sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt));
 render();
}

function bind(){
 const openSiteDialog=()=>{renderSites();$('#siteDialog').showModal()};
 $('#siteButton').onclick=openSiteDialog;
 $('#startSiteButton').onclick=openSiteDialog;
 $('#reportMetaButton').onclick=openReportMeta;
 $('#closeReportMetaButton').onclick=closeReportMeta;
 $('#saveReportMetaButton').onclick=saveReportMeta;
 $('#reportCoverPhoto').onchange=e=>previewCoverPhoto(e.target.files?.[0]||null);
 document.querySelectorAll('.stage-choice').forEach(button=>{button.onclick=()=>{state.activeStage=button.dataset.stage||'';recordEvent('capture_stage_selected',{stage:state.activeStage});setStatus(`${state.activeStage} として次の写真を記録します`);render()}});
 $('#placeButton').onclick=()=>openPlaceDialog(null);
 $('#moveButton').onclick=()=>{state.activePlace=null;recordEvent('place_boundary',{reason:'explicit_move'});setStatus('場所を解除しました。次の場所を選ぶまで写真は「場所未設定」で残ります');render()};
 $('#createSiteButton').onclick=createOrNameSite;
 $('#createPlaceButton').onclick=createPlace;
 $('#photoCapture').onchange=e=>captureFiles(e.target.files);
 $('#photoImport').onchange=e=>captureFiles(e.target.files);
 $('#unresolvedButton').onclick=toggleUnresolved;
 $('#finishButton').onclick=requestFinish;
 $('#finishReviewButton').onclick=()=>{state.showUnresolvedOnly=true;$('#finishDialog').close();render();document.querySelector('#photoGrid')?.scrollIntoView({behavior:'smooth',block:'start'})};
 $('#finishAnywayButton').onclick=()=>{$('#finishDialog').close();finishVisit()};
 $('#reportButton').onclick=openReportPreview;
 $('#closeReportButton').onclick=()=>$('#reportDialog').close();
 $('#shareReportButton').onclick=shareReport;
 $('#printReportButton').onclick=()=>window.print();
 $('#installHelpButton').onclick=()=>$('#installDialog').showModal();
 $('#closeInstallButton').onclick=()=>$('#installDialog').close();
 $('#closePhotoDetailButton').onclick=()=>$('#photoDetailDialog').close();
 $('#savePhotoDetailButton').onclick=savePhotoDetail;
 document.querySelectorAll('.preset-choice').forEach(button=>{button.onclick=()=>{$('#photoCommentInput').value=button.dataset.comment||''}});
}

async function createOrNameSite(){
 const name=$('#newSiteName').value.trim(); if(!name)return setStatus('現場名を入力してください');
 if(state.site?.placeholder && state.visit){
  state.site={...state.site,name,placeholder:false,updatedAt:isoNow()};await put('sites',state.site);await recordEvent('site_named_after_capture',{name});
  $('#newSiteName').value='';$('#siteDialog').close();setStatus(`${name} として現場を保存しました`);render();return;
 }
 const site={id:uuid(),name,placeholder:false,places:[],customerCompany:'',address:'',reportTitle:'作業報告書',basicWork:'',coverPhotoBlob:null,kvCache:{lastWorkTitle:'',recentComments:[],placementCounts:{},placementByPhoto:{}},createdAt:isoNow(),updatedAt:isoNow()};await put('sites',site);await recordEvent('site_created',{siteId:site.id});$('#newSiteName').value='';$('#siteDialog').close();await startOrResumeVisit(site);setStatus('新しい現場を開きました')
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
 const cached=siteKV().recentComments;const items=[];const seen=new Set();
 for(const comment of cached){if(seen.has(comment))continue;seen.add(comment);items.push(['前回',comment,'cached'])}
 for(const [label,comment] of BUILTIN_PRESETS){if(seen.has(comment))continue;seen.add(comment);items.push([label,comment,'builtin'])}
 for(const [label,comment,kind] of items.slice(0,10)){const b=document.createElement('button');b.type='button';b.className='preset-choice';b.dataset.comment=comment;b.dataset.kind=kind;b.textContent=kind==='cached'?`↻ ${comment}`:label;b.onclick=()=>{$('#photoCommentInput').value=comment};root.append(b)}
}
function renderKVHints(){
 const root=$('#reportKVHints');if(!root)return;root.innerHTML='';const kv=siteKV();const current=$('#reportWorkTitle').value.trim();
 if(kv.lastWorkTitle&&kv.lastWorkTitle!==current){const b=document.createElement('button');b.type='button';b.className='kv-suggestion';b.textContent=`前回の作業を使う：${kv.lastWorkTitle}`;b.onclick=()=>{$('#reportWorkTitle').value=kv.lastWorkTitle;root.hidden=true};root.append(b);root.hidden=false}else root.hidden=true;
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
async function saveReportMeta(){
 if(!state.site||state.site.placeholder)return setStatus('現場名を先に決めてください');
 const customerCompany=$('#reportCustomerCompany').value.trim();const address=$('#reportSiteAddress').value.trim();const reportTitle=$('#reportTitleInput').value.trim()||'作業報告書';const basicWork=$('#reportBasicWork').value.trim();
 let coverFields={};
 if(state.pendingCoverPhoto){const durable=await fileToDurableImage(state.pendingCoverPhoto);coverFields={coverPhotoBytes:durable.bytes,coverPhotoType:durable.type,coverPhotoName:durable.name,coverPhotoBlob:null}}
 state.site={...state.site,customerCompany,address,reportTitle,basicWork,...coverFields,updatedAt:isoNow()};await put('sites',state.site);
 if(state.visit){const workerName=$('#reportWorkerName').value.trim();const workTitle=$('#reportWorkTitle').value.trim();const specialNotes=$('#reportSpecialNotes').value.trim();state.visit={...state.visit,workerName,workTitle,specialNotes};await put('visits',state.visit);if(workerName)localStorage.setItem('field-report-last-worker',workerName);if(workTitle)await updateSiteKV(kv=>({...kv,lastWorkTitle:workTitle}))}
 await recordEvent('report_metadata_saved',{hasCover:!!imageBlobFromRecord(state.site),hasAddress:!!address,hasWorker:!!state.visit?.workerName,kvLastWorkTitle:siteKV().lastWorkTitle||null});closeReportMeta();setStatus('報告書情報を保存しました。表紙・住所・基本作業は次回も使います');render();
}

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
  state.photos=migrated;state.site=site;state.activePlace=null;localStorage.setItem('field-report-last-site',site.id);
  await recordEvent('site_late_resolved',{fromSiteId,selectedSiteId:id,photoCount:state.photos.length});
  setStatus(`${site.name} として現場を確認しました。先に撮った写真もそのまま残っています`);render();return;
 }
 await startOrResumeVisit(site);await recordEvent('site_selected',{selectedSiteId:id});setStatus('現場を開きました')
}
async function selectPlace(id){const p=state.site?.places.find(x=>x.id===id);if(p){await applyPlace(p);$('#placeDialog').close();render()}}
async function applyPlace(place){
 if(state.resolvingPhotoId){await resolvePhotoPlace(state.resolvingPhotoId,place);state.resolvingPhotoId=null;return}
 state.activePlace=place;await recordEvent('place_selected',{placeId:place.id,path:place.path});setStatus(`${pathLabel(place.path)} で撮影できます`);
}

function openPhotoDetail(photoId){
 const photo=state.photos.find(p=>p.id===photoId);if(!photo)return;
 state.editingPhotoId=photoId;$('#photoStageSelect').value=photoStage(photo);$('#photoCommentInput').value=photoComment(photo);renderPresetChoices();$('#photoDetailDialog').showModal();
}
async function savePhotoDetail(){
 const index=state.photos.findIndex(p=>p.id===state.editingPhotoId);if(index<0)return;
 const stage=$('#photoStageSelect').value;const comment=$('#photoCommentInput').value.trim();
 const next={...state.photos[index],stage,comment};await put('photos',next);state.photos[index]=next;
 if(stage)state.activeStage=stage;
 await learnComment(comment);await learnPlacement(next);const cHash=photoCapability(next).hash;
 await recordEvent('photo_detail_saved',{photoId:next.id,stage,hasComment:!!comment,cHash});
 $('#photoDetailDialog').close();state.editingPhotoId=null;setStatus('写真の区分と報告文を保存しました');render();
}

async function captureFiles(files){
 if(!files?.length)return;
 await ensureWorkingContext();
 for(const file of [...files]){
  const durable=await fileToDurableImage(file);
  const photo={id:uuid(),visitId:state.visit.id,siteSnapshot:{id:state.site.id,name:state.site.name},placeSnapshot:state.activePlace?{id:state.activePlace.id,path:[...state.activePlace.path]}:null,placeResolution:null,stage:state.activeStage||'',comment:'',capturedAt:isoNow(),name:durable.name,type:durable.type,bytes:durable.bytes};
  await put('photos',photo);state.photos.push(photo);await learnPlacement(photo);const cHash=photoCapability(photo).hash;await recordEvent(photo.placeSnapshot?'capture_resolved':'capture_unresolved',{photoId:photo.id,placeId:photo.placeSnapshot?.id||null,cHash});
 }
 $('#photoCapture').value='';$('#photoImport').value='';const stageText=state.activeStage?` / ${state.activeStage}`:'';setStatus(state.activePlace?`写真を場所付きで保存しました${stageText}`:`写真を保存しました${stageText}。場所は未設定のまま保持しています`);render()
}

async function resolvePhotoPlace(photoId,place){
 const index=state.photos.findIndex(p=>p.id===photoId);if(index<0)return;
 const photo=state.photos[index];if(!isUnresolved(photo))return;
 const resolvedAt=isoNow();const ageMs=Math.max(0,new Date(resolvedAt)-new Date(photo.capturedAt));
 const next={...photo,placeResolution:{id:place.id,path:[...place.path],resolvedAt}};await put('photos',next);state.photos[index]=next;
 await recordEvent('photo_late_resolved',{photoId,placeId:place.id,ageMs});setStatus(`写真の場所を ${pathLabel(place.path)} と確認しました。撮影時未確認の履歴は保持しています`);
}

function toggleUnresolved(){state.showUnresolvedOnly=!state.showUnresolvedOnly;render()}
function requestFinish(){
 if(!state.visit)return setStatus('まず撮影できます。現場名はあとで決められます');
 const unresolved=state.photos.filter(isUnresolved).length;
 const missingDetail=state.photos.filter(needsReportDetail).length;
 if(!unresolved&&!missingDetail)return finishVisit();
 const parts=[];if(unresolved)parts.push(`場所未確認 ${unresolved}枚`);if(missingDetail)parts.push(`区分・報告文の未入力 ${missingDetail}枚`);
 $('#finishSummary').textContent=`写真 ${state.photos.length}枚。${parts.join('、')}があります。写真は消さず、このまま完了もできます。`;
 $('#finishReviewButton').hidden=!unresolved;
 $('#finishReviewButton').textContent=unresolved?`場所未確認 ${unresolved}枚だけ見る`:'未確認だけ見る';
 $('#finishDialog').showModal();
}
async function finishVisit(){if(!state.visit)return setStatus('まず撮影できます');const unresolved=state.photos.filter(isUnresolved).length;state.visit.completedAt=isoNow();await put('visits',state.visit);await recordEvent('visit_completed',{photoCount:state.photos.length,unresolvedCount:unresolved});setStatus(unresolved?`今日の現場を完了しました。未確認 ${unresolved}枚はそのまま保持しています`:'今日の現場を完了しました。もう帰れます');render()}

async function blobToDataURL(blob){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(r.error);r.readAsDataURL(blob)})}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function buildReportHTML(){
 if(!state.site||!state.visit)throw new Error('report context missing');
 const groups=new Map();
 for(const p of placedPhotosForReport(state.photos)){const label=pathLabel(effectivePlace(p));if(!groups.has(label))groups.set(label,[]);groups.get(label).push(p)}
 const sections=[];
 for(const [label,photos] of groups){
  const cards=[];
  for(const p of photos){
   const provenance=p.placeSnapshot?'撮影時に確認':p.placeResolution?'後から確認':'未確認';
   const stage=photoStage(p)||'区分未設定';const comment=photoComment(p)||'報告文未入力';
   const capability=photoCapability(p);const imageData=await imageRecordToDataURL(p);
   const imageHTML=imageData?`<img src="${imageData}" alt="現場写真">`:`<div class="report-image-missing">画像を読み込めません<br><small>記録・コメントは保持されています</small></div>`;
   cards.push(`<article class="report-photo" data-chash="${capability.hash}" data-placement="${esc(capability.placement)}">${imageHTML}<div><p class="report-stage">${esc(stage)}</p><h3>${esc(label)}</h3><p class="report-comment">${esc(comment)}</p><p class="report-provenance">${esc(provenance)} · ${esc(new Date(p.capturedAt).toLocaleString('ja-JP'))}</p></div></article>`)
  }
  sections.push(`<section class="report-group"><h2>${esc(label)} <span>${photos.length}枚</span></h2><div class="report-photo-grid">${cards.join('')}</div></section>`)
 }
 const displayName=state.site.placeholder?'現場未設定':state.site.name;
 const unresolved=state.photos.filter(isUnresolved).length;
 const coverData=await imageRecordToDataURL(state.site);
 const coverImage=coverData?`<img class="report-cover-image" src="${coverData}" alt="${esc(displayName)} 店舗外観">`:`<div class="report-cover-missing">店舗外観写真 未設定</div>`;
 const customer=state.site.customerCompany||'';const address=state.site.address||'';const reportTitle=state.site.reportTitle||'作業報告書';const worker=state.visit.workerName||'';const workTitle=state.visit.workTitle||'';const basicWork=state.site.basicWork||'';const specialNotes=state.visit.specialNotes||'';
 const cover=`<section class="report-cover"><p class="report-cover-kicker">${esc(reportTitle)}</p><h1>${esc(displayName)}</h1>${address?`<p class="report-cover-address">${esc(address)}</p>`:''}${coverImage}<dl class="report-cover-meta"><div><dt>施工日時</dt><dd>${esc(state.visit.workDate)}</dd></div><div><dt>作業責任者</dt><dd>${esc(worker||'未入力')}</dd></div>${customer?`<div><dt>顧客・会社名</dt><dd>${esc(customer)}</dd></div>`:''}${workTitle?`<div><dt>今回の作業</dt><dd>${esc(workTitle)}</dd></div>`:''}</dl>${basicWork?`<section class="report-basic-work"><h2>基本作業</h2><p>${esc(basicWork)}</p></section>`:''}<footer>株式会社ガヤ・コーポレーション</footer></section>`;
 const notes=`<section class="report-special"><h2>特別報告事項</h2><h3>【所見・備考】</h3><p>${esc(specialNotes||'特記事項なし')}</p></section>`;
 const reportBody=`<section class="report-body"><header><p class="eyebrow">FIELD REPORT</p><h1>${esc(workTitle||'作業報告')}</h1><p>${esc(displayName)} · ${esc(state.visit.workDate)} · 写真 ${state.photos.length}枚</p></header>${sections.join('')}${notes}</section>`;
 const body=`<article class="report-document">${cover}${reportBody}</article>`;
 const html=`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(displayName)} Field REPORT</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif;color:#191a17;max-width:900px;margin:auto;padding:28px}.eyebrow{font-size:12px;font-weight:750;letter-spacing:.12em;color:#66685f}.report-cover{text-align:center;min-height:calc(100vh - 56px);display:flex;flex-direction:column;justify-content:flex-start}.report-cover-kicker{font-size:28px;font-weight:800;margin:18px 0 24px}.report-cover h1{font-size:32px;margin:0}.report-cover-address{margin:8px 0 24px}.report-cover-image,.report-cover-missing{width:100%;height:420px;object-fit:cover;background:#f0f0eb;border-radius:6px}.report-cover-missing{display:grid;place-items:center;color:#777}.report-cover-meta{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;text-align:left;margin:24px auto 12px;max-width:620px}.report-cover-meta div{display:grid;grid-template-columns:110px 1fr}.report-cover-meta dt{font-weight:700}.report-cover-meta dd{margin:0}.report-basic-work{text-align:left;max-width:620px;margin:12px auto}.report-basic-work h2{font-size:15px}.report-basic-work p{white-space:pre-wrap}.report-cover footer{margin-top:auto;padding-top:20px;font-size:18px;font-weight:800}.report-body>header{margin-bottom:28px}.report-body>header h1{font-size:30px}.report-group{margin:30px 0}.report-group h2{border-bottom:1px solid #ddd;padding-bottom:8px}.report-group h2 span{font-size:14px;color:#666}.report-photo-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.report-photo{break-inside:avoid;margin:0 0 10px}.report-photo img,.report-image-missing{width:100%;aspect-ratio:4/3;object-fit:cover;background:#f4f4ef;border-radius:4px}.report-image-missing{display:grid;place-items:center;text-align:center;color:#777}.report-image-missing small{font-size:11px}.report-photo h3{margin:9px 0 2px}.report-photo p{margin:0;color:#666}.report-comment{color:#333!important;white-space:pre-wrap}.report-provenance{font-size:11px}.report-special{break-inside:avoid;margin-top:40px;border-top:2px solid #b33;padding-top:14px}.report-special p{white-space:pre-wrap;background:#fff6d9;padding:18px;min-height:80px}@media(max-width:620px){.report-photo-grid{grid-template-columns:1fr}.report-cover-image,.report-cover-missing{height:46vh}.report-cover-meta{grid-template-columns:1fr}}@media print{body{padding:0;max-width:none}.report-cover{height:100vh;min-height:0;break-after:page}.report-body{break-before:page}.report-photo{page-break-inside:avoid}.report-photo-grid{grid-template-columns:1fr 1fr}}</style></head><body>${body}</body></html>`;
 state.reportHTML=html;
 state.reportFilename=`Field-REPORT-${state.visit.workDate}-${safeFilename(displayName)}.html`;
 return {html,body,displayName,unresolved};
}

async function openReportPreview(){
 if(!state.site||!state.visit||!state.photos.length)return setStatus('報告にする写真がまだありません');
 setStatus('報告をまとめています…');
 try{
  const report=await buildReportHTML();
  $('#reportPreview').innerHTML=report.body;
  if(!$('#reportDialog').open)$('#reportDialog').showModal();
  const missingImages=$('#reportPreview').querySelectorAll('.report-image-missing').length;
  recordEvent('report_previewed',{photoCount:state.photos.length,unresolvedCount:report.unresolved,missingImageCount:missingImages});
  setStatus(missingImages?`報告を開きました。画像を読み込めない写真 ${missingImages}枚は記録を残したまま表示しています`:'報告をアプリ内で開きました');
 }catch(e){console.error(e);setStatus('報告を開けませんでした。写真はそのまま残っています')}
}

async function shareReport(){
 if(!state.reportHTML)await buildReportHTML();
 const file=new File([state.reportHTML],state.reportFilename,{type:'text/html'});
 try{
  if(navigator.share && (!navigator.canShare || navigator.canShare({files:[file]}))){
   await navigator.share({title:'Field REPORT',files:[file]});
   await recordEvent('report_shared',{method:'web-share-file'});
   setStatus('共有メニューを開きました');
   return;
  }
 }catch(e){
  if(e?.name==='AbortError')return;
  console.warn('web share failed',e);
 }
 const url=URL.createObjectURL(file);const a=document.createElement('a');a.href=url;a.download=state.reportFilename;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
 await recordEvent('report_shared',{method:'download-fallback'});
 setStatus('この端末では直接共有できないため、報告ファイルとして保存しました');
}

async function semanticStagnationSummary(){
 const now=Date.now();const unresolved=state.photos.filter(isUnresolved);const events=await getAll('events');return {unresolvedCount:unresolved.length,unresolvedAgeMs:unresolved.reduce((n,p)=>n+Math.max(0,now-new Date(p.capturedAt).getTime()),0),lateResolutionCount:events.filter(e=>e.type==='photo_late_resolved').length,eventCount:events.length,blockedCaptureCount:0};
}

function renderSites(){getAll('sites').then(sites=>{$('#siteList').innerHTML='';sites.filter(s=>!s.placeholder).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).forEach(s=>{const b=document.createElement('button');b.type='button';b.className='site-choice';b.innerHTML=`<strong>${esc(s.placeholder?'現場未設定':s.name)}</strong><small>覚えている場所 ${s.places.length}件</small>`;b.onclick=()=>selectSite(s.id);$('#siteList').append(b)});if(!sites.some(s=>!s.placeholder))$('#siteList').innerHTML='<p class="empty">保存済みの現場はまだありません。</p>'})}
function renderPlaces(){const root=$('#placeList');root.innerHTML='';if(!state.site){root.innerHTML='<p class="empty">場所はあとで決められます。まず撮影できます。</p>';return}state.site.places.forEach(p=>{const b=document.createElement('button');b.type='button';b.className='place-choice';b.textContent=pathLabel(p.path);b.onclick=()=>selectPlace(p.id);root.append(b)});if(!state.site.places.length)root.innerHTML='<p class="empty">場所はまだありません。必要になった場所だけ追加してください。</p>'}
function nextStepText(){
 if(!state.site)return 'そのまま撮影できます。現場名はあとで決められます。';
 if(state.site.placeholder)return '撮影を続けられます。現場名は分かった時に決めれば大丈夫です。';
 if(state.visit?.completedAt)return '今日の現場は完了です。必要なら報告を作って共有できます。';
 const unresolved=state.photos.filter(isUnresolved).length;
 if(unresolved)return `撮影を続けられます。場所未確認 ${unresolved}枚は最後にその枚数だけ確認できます。`;
 if(!state.photos.length)return '場所を選んで撮影。場所が分からなければ、そのまま撮って大丈夫です。';
 return '撮影を続ける。終わったら「今日の現場を完了する」で今日を閉じます。';
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
 $('#stageCard').hidden=!hasNamedSite;
 $('#mainCaptureZone').hidden=stage==='site';
 $('#recordCard').hidden=!state.photos.length;
 $('#finishZone').hidden=!state.photos.length;
 $('#siteSubtitle').textContent=stage==='site'?'最初に、今日どこで仕事するかだけ決めます。':state.visit?`${state.visit.workDate} / ${state.visit.completedAt?'完了':'作業中'}`:'撮った時に分かっていた意味を、そのまま残す。';
 $('#currentPlace').textContent=state.activePlace?pathLabel(state.activePlace.path):'どこで撮る？';
 $('#placeHint').textContent=state.activePlace?'この場所を写真へ記録します。':'分かる範囲だけで大丈夫。分からなくても撮影できます。';
 $('#placeButton').hidden=!!state.activePlace;
 $('#placeButton').textContent=state.site?.places?.length?'場所を選ぶ':'場所を決める';
 $('#currentStage').textContent=state.activeStage||'区分未設定';
 document.querySelectorAll('.stage-choice').forEach(button=>button.classList.toggle('active',button.dataset.stage===state.activeStage));
 $('#stageHint').textContent=state.activeStage?`${state.activeStage} を次の写真へ引き継ぎます。変わった時だけ押し直します。`:'区分は後からでも付けられます。今分かるなら一度だけ選んでください。';
 $('#moveButton').hidden=!state.activePlace;
 $('#moveButton').textContent='場所を変える';
 const captureLabel=$('#captureLabel');
 captureLabel.textContent=stage==='place'?'場所未設定で撮影':'📷 撮影';
 captureLabel.classList.toggle('capture-secondary',stage==='place');
 const unresolved=state.photos.filter(isUnresolved).length;
 $('#photoCount').textContent=state.photos.length;
 $('#unresolvedButton').textContent=state.showUnresolvedOnly?'すべて見る':`未確認 ${unresolved}`;
 $('#unresolvedButton').disabled=!unresolved && !state.showUnresolvedOnly;
 $('#unresolvedButton').classList.toggle('active',state.showUnresolvedOnly);
 const grid=$('#photoGrid');grid.innerHTML='';const visible=state.showUnresolvedOnly?state.photos.filter(isUnresolved):state.photos;$('#emptyPhotos').hidden=visible.length>0;$('#emptyPhotos').textContent=state.showUnresolvedOnly?'場所未確認の写真はありません。':'まだ写真はありません。';visible.slice().reverse().forEach(p=>{const node=$('#photoTemplate').content.cloneNode(true);const card=node.querySelector('.photo-item');const capability=photoCapability(p);if(card){card.dataset.chash=capability.hash;card.dataset.placement=capability.placement}const img=node.querySelector('img');const url=imageRecordObjectURL(p);if(url){img.src=url;img.onload=()=>URL.revokeObjectURL(url);img.onerror=()=>{URL.revokeObjectURL(url);imageRecordToDataURL(p).then(data=>{if(data){img.onerror=()=>{img.removeAttribute('src');img.alt='画像を読み込めません';img.classList.add('image-missing')};img.src=data}else{img.removeAttribute('src');img.alt='画像を読み込めません';img.classList.add('image-missing')}})}}else{img.removeAttribute('src');img.alt='画像を読み込めません';img.classList.add('image-missing')}node.querySelector('.photo-place').textContent=pathLabel(effectivePlace(p));node.querySelector('.photo-time').textContent=new Date(p.capturedAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});node.querySelector('.photo-stage').textContent=photoStage(p)||'区分未設定';node.querySelector('.photo-comment').textContent=photoComment(p)||'報告文未入力';const detailAction=node.querySelector('.photo-detail-action');detailAction.onclick=()=>openPhotoDetail(p.id);const provenance=node.querySelector('.photo-provenance');const action=node.querySelector('.photo-action');if(p.placeSnapshot){provenance.textContent='撮影時に場所確認';action.hidden=true}else if(p.placeResolution){provenance.textContent='撮影時未確認 → 後から確認';action.hidden=true}else{provenance.textContent='場所はまだ未確認';action.hidden=false;action.onclick=()=>openPlaceDialog(p.id)}grid.append(node)});
 const completed=!!state.visit?.completedAt;
 $('#finishButton').hidden=completed;
 $('#finishButton').disabled=!state.visit||completed;
 $('#reportButton').disabled=!state.visit||!state.photos.length;
 $('#reportButton').textContent=completed?'報告を見る':'途中の報告を見る';
 $('#reportButton').classList.toggle('primary',completed);
 $('#reportButton').classList.toggle('secondary',!completed);
 const standalone=window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true;
 $('#installHelpButton').hidden=standalone;
 $('#nextStep').textContent=nextStepText();
}
function setStatus(s){$('#status').textContent=s}

async function runSelfTest(){
 // Shutter first: no site setup is allowed to block evidence capture.
 const pixel=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAAwAAf4CBmUAAAAASUVORK5CYII='),c=>c.charCodeAt(0));const first=new File([pixel],'selftest-a.png',{type:'image/png'});await captureFiles([first]);
 if(!state.site?.placeholder||state.photos.length!==1||!isUnresolved(state.photos[0]))throw new Error('shutter-first failed');
 const originalSiteId=state.site.id;state.site={...state.site,name:'SELFTEST現場',placeholder:false,updatedAt:isoNow()};await put('sites',state.site);if(state.site.id!==originalSiteId)throw new Error('site identity changed while naming');
 const place={id:uuid(),path:['1F','厨房'],createdAt:isoNow()};state.site.places.push(place);await put('sites',state.site);state.activePlace=place;state.activeStage='施工前';
 const second=new File([pixel],'selftest-b.png',{type:'image/png'});await captureFiles([second]);if(pathLabel(state.photos[1].placeSnapshot?.path)!=='1F・厨房')throw new Error('semantic capture failed');if(photoStage(state.photos[1])!=='施工前')throw new Error('capture stage inheritance failed');
 openPhotoDetail(state.photos[1].id);$('#photoCommentInput').value='異常は確認されませんでした';await savePhotoDetail();if(photoComment(state.photos[1])!=='異常は確認されませんでした')throw new Error('photo report text save failed');if(!siteKV().recentComments.includes('異常は確認されませんでした'))throw new Error('KV comment cache failed');if(photoCapability(state.photos[1]).hash!==photoCapability(state.photos[1]).hash)throw new Error('cHash unstable');
 // Resolve the first photo later without rewriting capture-time truth.
 await resolvePhotoPlace(state.photos[0].id,place);if(state.photos[0].placeSnapshot!==null||pathLabel(state.photos[0].placeResolution?.path)!=='1F・厨房')throw new Error('late resolution rewrote capture truth');
 state.activePlace=null;const third=new File([pixel],'selftest-c.png',{type:'image/png'});await captureFiles([third]);if(!isUnresolved(state.photos[2]))throw new Error('unresolved capture failed');
 // Simulate a legacy iOS/WKWebView record whose image payload can no longer be read.
 const degraded={...state.photos[2],bytes:null,blob:null};await put('photos',degraded);state.photos[2]=degraded;
 const summary=await semanticStagnationSummary();if(summary.unresolvedCount!==1||summary.lateResolutionCount<1||summary.blockedCaptureCount!==0)throw new Error('stagnation ledger mismatch');const placed=placedPhotosForReport(state.photos.slice(0,2));if(placed[0].id!==state.photos[1].id)throw new Error('cHash placement failed');
 await updateSiteKV(kv=>({...kv,lastWorkTitle:'防鼠防虫作業'}));const firstVisit=state.visit.id;await finishVisit();if(!state.visit.completedAt)throw new Error('completion failed');await openReportPreview();if(!$('#reportDialog').open||$('#reportPreview').querySelectorAll('.report-photo').length!==3||!$('#reportPreview').querySelector('.report-cover')||$('#reportPreview').querySelectorAll('.report-image-missing').length!==1)throw new Error('in-app degraded-image report preview failed');$('#reportDialog').close();await startOrResumeVisit(state.site);if(state.visit.id===firstVisit)throw new Error('new visit not created');if(!state.site.places.some(p=>pathLabel(p.path)==='1F・厨房'))throw new Error('site memory lost');if(state.activePlace!==null)throw new Error('old authority restored');if(siteKV().lastWorkTitle!=='防鼠防虫作業'||!siteKV().recentComments.includes('異常は確認されませんでした'))throw new Error('KV cache lost');if(siteKV().placementCounts['1F・厨房|施工前']!==1)throw new Error('cHash placement double-counted');openReportMeta();if($('#reportWorkTitle').value!==''||$('#reportKVHints').hidden||!$('#reportKVHints').textContent.includes('防鼠防虫作業'))throw new Error('KV suggestion authority boundary failed');closeReportMeta();
 document.body.dataset.selftest='pass';document.body.dataset.unresolved='1';setStatus('SELFTEST PASS');
}

init().then(()=>{if(new URLSearchParams(location.search).get('selftest')==='1')return runSelfTest()}).catch(e=>{console.error(e);document.body.dataset.selftest='fail';setStatus('初期化に失敗しました。Safariのストレージ設定を確認してください')});
