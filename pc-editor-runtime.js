/* Self-contained, local-file PC report editor. Embedded inside exported HTML. */
(function(){
'use strict';
const CATEGORIES=['ゴキブリトラップ','ネズミ固形剤','ネズミ粉剤','衛生管理報告','特別報告'];
const EDITABLE=['.report-cover-kicker','.report-cover h1','.report-cover-address','.report-cover-meta dd','.report-basic-work p','.report-body>header h1','.report-special h3','.report-special p','.report-stage','.report-comment'];
const $=s=>document.querySelector(s);
const all=s=>[...document.querySelectorAll(s)];
const status=message=>{const e=$('#pcEditStatus');if(e)e.textContent=message};
let busy=false;
let dirty=false;
function markDirty(){dirty=true;status('編集内容はこの画面だけにあります。必ず「編集済みHTMLを保存」を押してください。')}
function groupName(group){
 if(group.dataset.placeLabel)return group.dataset.placeLabel;
 const h=group.querySelector(':scope > h3');
 const name=h?[...h.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim():'';
 return name||'場所未設定';
}
function groupHeader(group,name){
 const h=group.querySelector(':scope > h3');if(!h)return;
 let text=[...h.childNodes].find(n=>n.nodeType===Node.TEXT_NODE);
 if(!text){text=document.createTextNode('');h.prepend(text)}
 text.textContent=name+' ';
 group.dataset.placeLabel=name;
}
function updateCounts(){
 let total=0;
 for(const group of all('.report-group')){
  const count=group.querySelectorAll('.report-photo').length;total+=count;
  const h=group.querySelector(':scope > h3');if(!h)continue;
  let span=h.querySelector('span');if(!span){span=document.createElement('span');h.append(span)}
  span.textContent=`${count}枚`;
 }
 const meta=$('.report-body>header p:last-child');
 if(meta)meta.textContent=meta.textContent.replace(/写真\s*\d+枚/g,`写真 ${total}枚`);
}
function refreshPlaces(){
 const names=[...new Set(all('.report-group').map(groupName))].sort((a,b)=>a.localeCompare(b,'ja'));
 const placeSelect=$('#pcOldPlace');const old=placeSelect.value;placeSelect.replaceChildren();
 names.forEach(name=>{const option=document.createElement('option');option.value=name;option.textContent=name;placeSelect.append(option)});
 if(names.includes(old))placeSelect.value=old;
}
function sectionCategory(section){return section.dataset.workCategory||section.querySelector(':scope > h2')?.textContent.replace(/^\d+\.\s*/,'').trim()||''}
function getSection(category){
 const existing=all('.report-work-section').find(section=>sectionCategory(section)===category);
 if(existing)return existing;
 const section=document.createElement('section');section.className='report-work-section';section.dataset.workCategory=category;
 const h=document.createElement('h2');h.textContent=`${CATEGORIES.indexOf(category)+1}. ${category}`;section.append(h);
 const reportBody=$('.report-body');const notes=$('.report-special');
 const next=all('.report-work-section').find(s=>CATEGORIES.indexOf(sectionCategory(s))>CATEGORIES.indexOf(category));
 reportBody.insertBefore(section,next||notes||null);return section;
}
function getGroup(category,place){
 const section=getSection(category);
 const existing=[...section.querySelectorAll(':scope > .report-group')].find(g=>groupName(g)===place);
 if(existing)return existing;
 const group=document.createElement('section');group.className='report-group';group.dataset.placeLabel=place;
 const header=document.createElement('h3');const span=document.createElement('span');span.textContent='0枚';header.append(document.createTextNode(place+' '),span);
 const grid=document.createElement('div');grid.className='report-photo-grid';group.append(header,grid);section.append(group);
 return group;
}
function showPanel(id){for(const panel of ['pcAddPanel','pcRenamePanel']){$('#'+panel).hidden=panel!==id}}
function rebuildGroupActions(){
 all('.pc-group-actions').forEach(e=>e.remove());
 for(const group of all('.report-group')){
  const name=groupName(group);groupHeader(group,name);
  const actions=document.createElement('div');actions.className='pc-group-actions pc-dynamic-control';
  const add=document.createElement('button');add.type='button';add.textContent='この場所に写真を追加';
  add.onclick=()=>{showPanel('pcAddPanel');$('#pcWorkCategory').value=sectionCategory(group.closest('.report-work-section'));$('#pcPlaceName').value=groupName(group);$('#pcAddPanel').scrollIntoView({block:'nearest'});$('#pcAddFiles').click()};
  const rename=document.createElement('button');rename.type='button';rename.textContent='場所名をまとめて変更';
  rename.onclick=()=>{showPanel('pcRenamePanel');refreshPlaces();$('#pcOldPlace').value=groupName(group);$('#pcNewPlace').value=groupName(group);$('#pcNewPlace').focus()};
  actions.append(add,rename);group.querySelector(':scope > h3').after(actions);
 }
 refreshPlaces();updateCounts();
}
function renameLinkedPlace(){
 const old=$('#pcOldPlace').value;const updated=$('#pcNewPlace').value.trim();
 if(!old||!updated){status('変更前と変更後の場所名を入力してください');return}
 let groups=0,photos=0;
 for(const group of all('.report-group')){
  if(groupName(group)!==old)continue;
  groupHeader(group,updated);groups++;
  group.querySelectorAll('.report-photo h3').forEach(h=>{h.textContent=updated;photos++});
 }
 // Merge groups that now have the same location within the same work category.
 for(const section of all('.report-work-section')){
  const matches=[...section.querySelectorAll(':scope > .report-group')].filter(g=>groupName(g)===updated);
  for(const duplicate of matches.slice(1)){
   const destination=matches[0].querySelector('.report-photo-grid');
   duplicate.querySelectorAll('.report-photo').forEach(card=>destination.append(card));duplicate.remove();
  }
 }
 rebuildGroupActions();markDirty();showPanel(null);
 status(`場所名を「${old}」から「${updated}」へ変更しました。${groups}グループ・${photos}枚に反映。編集済みHTMLを保存してください。`);
}
function fileAsDataURL(file){
 return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error||new Error('読み込み失敗'));reader.readAsDataURL(file)})
}
function supportedPhoto(file){return /^(image\/(jpeg|png|webp|gif))$/.test(file?.type||'')}
function createPhotoCard(source,name,place,category){
 const article=document.createElement('article');article.className='report-photo';article.dataset.pcAdded='true';
 article.dataset.photoId='pc-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
 const img=document.createElement('img');img.src=source;img.alt='PCで追加した写真';
 const detail=document.createElement('div');const stage=document.createElement('p');stage.className='report-stage';stage.textContent='区分未設定';
 const h=document.createElement('h3');h.textContent=place;
 const comment=document.createElement('p');comment.className='report-comment';comment.textContent=name+'：報告文を入力してください';
 const provenance=document.createElement('p');provenance.className='report-provenance';provenance.textContent=`PCで後日追加 · ${category}`;
 detail.append(stage,h,comment,provenance);article.append(img,detail);return article;
}
async function addPhotos(){
 if(busy)return;
 const category=$('#pcWorkCategory').value,place=$('#pcPlaceName').value.trim();
 const files=[...$('#pcAddFiles').files];
 if(!CATEGORIES.includes(category)||!place||!files.length){status('施工工程・場所名・追加する写真を指定してください');return}
 if(files.some(f=>!supportedPhoto(f))){status('追加写真はJPEG / PNG / WebP / GIFに対応します。HEICはJPEGへ変換してください。');return}
 busy=true;$('#pcAddConfirm').disabled=true;
 try{
  // Read all files before mutating the report, so one invalid file never produces a half-import.
  const images=await Promise.all(files.map(async file=>({name:file.name,src:await fileAsDataURL(file)})));
  const group=getGroup(category,place);const grid=group.querySelector('.report-photo-grid');
  for(const image of images)grid.append(createPhotoCard(image.src,image.name,place,category));
  $('#pcAddFiles').value='';rebuildGroupActions();enableEditing();markDirty();showPanel(null);
  status(`${images.length}枚を「${category} / ${place}」へ追加しました。編集済みHTMLを保存してください。`);
 }catch(err){status('写真を取り込めませんでした：'+String(err).slice(0,180))}
 finally{busy=false;$('#pcAddConfirm').disabled=false}
}
function replaceImage(img){
 const input=document.createElement('input');input.type='file';input.accept='image/jpeg,image/png,image/webp,image/gif';
 input.onchange=async()=>{const file=input.files?.[0];if(!file)return;if(!supportedPhoto(file)){status('JPEG / PNG / WebP / GIFを選んでください');return}
  try{const src=await fileAsDataURL(file);img.src=src;markDirty()}catch(err){status('写真差し替えに失敗しました：'+err)}
 };input.click();
}
function enableEditing(){
 for(const selector of EDITABLE)all(selector).forEach(el=>{el.contentEditable='true';el.spellcheck=true;el.classList.add('pc-editable');el.title='クリックして編集'});
 all('.report-cover-image,.report-photo img').forEach(img=>{img.classList.add('pc-image-editable');img.title='クリックして写真を差し替え';img.onclick=()=>replaceImage(img)});
 all('.report-edit-control').forEach(el=>el.remove());
}
function serializableHTML(){
 const clone=document.documentElement.cloneNode(true);
 clone.querySelectorAll('.pc-dynamic-control').forEach(el=>el.remove());
 clone.querySelectorAll('[contenteditable]').forEach(el=>{el.removeAttribute('contenteditable');el.classList.remove('pc-editable');el.removeAttribute('title')});
 clone.querySelectorAll('.pc-image-editable').forEach(el=>{el.classList.remove('pc-image-editable');el.removeAttribute('title');el.removeAttribute('onclick')});
 clone.querySelectorAll('.report-edit-control').forEach(el=>el.remove());
 const status=clone.querySelector('#pcEditStatus');if(status)status.textContent='PC編集モード。保存したHTMLを開き直して編集できます。';
 for(const panel of ['pcAddPanel','pcRenamePanel']){const el=clone.querySelector('#'+panel);if(el)el.setAttribute('hidden','')}
 return '<!doctype html>\n'+clone.outerHTML;
}
function downloadHTML(){
 if(busy){status('写真を読み込み中です。完了してから保存してください');return}
 const text=serializableHTML();const blob=new Blob([text],{type:'text/html;charset=utf-8'});
 const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;
 link.download=document.title.replace(/[\\/:*?"<>|]/g,'_')+'-編集済み.html';link.click();
 setTimeout(()=>URL.revokeObjectURL(url),60000);dirty=false;
 status('編集済みHTMLの保存を要求しました。ダウンロード先を確認してください。');
}
function boot(){
 for(const category of CATEGORIES){const option=document.createElement('option');option.value=category;option.textContent=category;$('#pcWorkCategory').append(option)}
 $('#saveEditedHTMLButton').onclick=downloadHTML;
 $('#pcPrintButton').onclick=()=>{if(busy){status('写真の追加処理が完了してから印刷してください');return}window.print()};
 $('#pcAddPhotoButton').onclick=()=>{showPanel('pcAddPanel');$('#pcPlaceName').focus()};
 $('#pcRenamePlaceButton').onclick=()=>{showPanel('pcRenamePanel');refreshPlaces();$('#pcNewPlace').value=$('#pcOldPlace').value;$('#pcNewPlace').focus()};
 $('#pcAddConfirm').onclick=addPhotos;$('#pcRenameConfirm').onclick=renameLinkedPlace;
 $('#pcAddClose').onclick=$('#pcRenameClose').onclick=()=>showPanel(null);
 $('#pcOldPlace').onchange=()=>{$('#pcNewPlace').value=$('#pcOldPlace').value};
 document.addEventListener('input',event=>{if(event.target.closest('[contenteditable]'))markDirty()});
 enableEditing();rebuildGroupActions();
 status('PC編集モード。写真追加・場所名変更・文章編集の後は、編集済みHTMLを保存してください。');
}
boot();
})();
