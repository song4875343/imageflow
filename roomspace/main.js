import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createPlanEditor } from './editor.js';
import './style.css';
import './overrides.css';
import './panel-scroll.css';

const colors = { wall: 0xe9e6dc, ink: 0x283b32, floor: 0xb9b4a6, floorInset: 0xc7c2b6, glass: 0x87b4bd, frame: 0x244438, oak: 0x9d6b45, oakDark: 0x68432d, core: 0x678c87, coreDark: 0x355e58, rust: 0xa34d32, rustDark: 0x71321f, cream: 0xd9d1c2, metal: 0x27352f };
const mats = Object.fromEntries(Object.entries(colors).map(([key, color]) => [key, new THREE.MeshStandardMaterial({ color, roughness: key === 'glass' ? 0.18 : 0.74, metalness: key === 'metal' ? 0.42 : 0 })]));
mats.glass.transparent = true; mats.glass.opacity = 0.43; mats.glass.depthWrite = false;
function applyCeilingAmbientFactor(material) {
  material.customProgramCacheKey = () => 'ceiling-ambient-0.10';
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );',
      'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor * 0.10 );'
    );
  };
  return material;
}
const ceilingMat = applyCeilingAmbientFactor(mats.wall.clone()); ceilingMat.side = THREE.DoubleSide; ceilingMat.emissive = new THREE.Color(0x000000); ceilingMat.emissiveIntensity = 0;
const edgeMat = new THREE.LineBasicMaterial({ color: colors.ink, transparent: true, opacity: 0.27 });
const scene = new THREE.Scene(); scene.background = new THREE.Color(0xdfe4df); scene.fog = new THREE.Fog(0xdfe4df, 80, 180);
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.03, 300); camera.setFocalLength(35); camera.position.set(12.6, 10.4, 12.8);
const topCamera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.03, 300); topCamera.position.set(0, 20, 0); topCamera.up.set(0, 0,-1); topCamera.lookAt(0, 0, 0);
let activeCamera = camera;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setSize(innerWidth, innerHeight); renderer.shadowMap.enabled = true; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05; document.querySelector('#scene').appendChild(renderer.domElement);
const invalidateShadows = () => { renderer.shadowMap.needsUpdate = true; };
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = false; controls.minDistance = 0.2; controls.maxDistance = 120; controls.minZoom = 0.08; controls.maxZoom = 40; controls.maxPolarAngle = Math.PI * 0.495; controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE; controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN; controls.mouseButtons.RIGHT = null; controls.target.set(0, 0.8, 0);
const architecture = new THREE.Group(), furniture = new THREE.Group(), walls = {}; let ceiling, sunEnabled = true; scene.add(architecture, furniture);
const cameraStorageKey='eroom-camera-presets-v1';
const readLegacyCameraPresets=()=>{ try{return JSON.parse(localStorage.getItem(cameraStorageKey)||'[]');}catch{return [];} };
const readCameraPresets=()=>Array.isArray(activeModel?.cameraPresets)?activeModel.cameraPresets:[];
const writeCameraPresets=presets=>{ if(activeModel) activeModel.cameraPresets=presets; };
function refreshCameraPresets(selectedId=''){ const presetSelect=document.querySelector('#cameraPreset'), presets=readCameraPresets(); presetSelect.innerHTML=''; if(!presets.length){ const option=document.createElement('option'); option.value=''; option.textContent='暂无已记录机位'; presetSelect.appendChild(option); document.querySelector('#cameraName').value=''; return; } presets.forEach(preset=>{ const option=document.createElement('option'); option.value=preset.id; option.textContent=preset.name; presetSelect.appendChild(option); }); presetSelect.value=selectedId&&presets.some(p=>p.id===selectedId)?selectedId:presets[0].id; document.querySelector('#cameraName').value=presets.find(p=>p.id===presetSelect.value)?.name||''; }
function recordCameraPreset(){
  if(activeCamera!==camera){ document.querySelector('.hint').textContent='请先在透视视图中调整机位，再记录相机'; return; }
  const presets=readCameraPresets(), count=presets.length, id=globalThis.crypto?.randomUUID?.()||String(Date.now()), name=`机位 ${count+1}`;
  const usesEditorScene=Array.isArray(activeModel.editor?.items);
  presets.push({id,modelId:activeModel.id,name,position:camera.position.toArray(),target:controls.target.toArray(),focalLength:Math.round(camera.getFocalLength()),wallVisibility:usesEditorScene?planEditor.getWallVisibility():Object.fromEntries(Object.entries(walls).map(([side,wall])=>[side,wall.visible])),ceilingVisible:usesEditorScene?planEditor.getCeilingVisibility():Boolean(ceiling?.visible),hiddenItemIds:usesEditorScene?planEditor.getHiddenItemIds():[],sun:{x:Number(sunXInput.value),z:Number(sunZInput.value),elevation:Number(sunElevationInput.value),enabled:sunEnabled,intensity:Number(sunIntensityInput.value),ambientIntensity:Number(ambientIntensityInput.value),perspectiveOutlines:perspectiveOutlinesInput.checked}});
  writeCameraPresets(presets);
  refreshCameraPresets(id);
  document.querySelector('.hint').textContent=`已记录 ${name} · 机位、墙体、天花和日照参数`;
}
function loadCameraPreset(id){
  const preset=readCameraPresets().find(p=>p.id===id);
  if(!preset)return;
  activeCamera=camera; controls.object=camera; controls.enableRotate=true; controls.minDistance=0.05; controls.maxDistance=120;
  camera.position.fromArray(preset.position); controls.target.fromArray(preset.target); camera.setFocalLength(preset.focalLength);
  focalInput.value=String(preset.focalLength); focalValue.textContent=`${preset.focalLength} mm`;
  const usesEditorScene=Array.isArray(activeModel.editor?.items);
  if(preset.wallVisibility){
    Object.entries(preset.wallVisibility).forEach(([side,visible])=>{
      if(usesEditorScene)planEditor.setWallVisibility(side,visible); else if(walls[side])walls[side].visible=Boolean(visible);
      document.querySelector(`[data-wall="${side}"]`)?.setAttribute('aria-pressed',String(Boolean(visible)));
    });
  }
  if(typeof preset.ceilingVisible==='boolean'){
    if(usesEditorScene)planEditor.setCeilingVisibility(preset.ceilingVisible); else { activeModel.ceilingVisible=Boolean(preset.ceilingVisible); if(ceiling)ceiling.visible=activeModel.ceilingVisible; }
    document.querySelector('#ceilingToggle').setAttribute('aria-pressed',String(preset.ceilingVisible));
  }
  if(usesEditorScene) planEditor.setHiddenItemIds(preset.hiddenItemIds || []);
  if(preset.sun){ sunXInput.value=String(preset.sun.x); sunZInput.value=String(preset.sun.z); sunElevationInput.value=String(preset.sun.elevation); if(typeof preset.sun.enabled==='boolean'){ sunEnabled=preset.sun.enabled; sunToggleInput.checked=sunEnabled; sunToggleInput.nextElementSibling.textContent=sunEnabled?'开启':'关闭'; } if(Number.isFinite(preset.sun.intensity)) sunIntensityInput.value=String(preset.sun.intensity); if(Number.isFinite(preset.sun.ambientIntensity)) ambientIntensityInput.value=String(preset.sun.ambientIntensity); if(typeof preset.sun.perspectiveOutlines==='boolean') perspectiveOutlinesInput.checked=preset.sun.perspectiveOutlines; updateSunIntensity(); updateAmbientLight(); updatePerspectiveOutlines(); updateSunPosition(); }
  controls.update(); document.querySelector('#cameraName').value=preset.name; document.querySelector('.hint').textContent=`${preset.name} · 已恢复机位、可见性和日照参数`; renderer.render(scene,activeCamera);
}
const cameraPresetSelect=document.querySelector('#cameraPreset');
const reloadSelectedCameraPreset=()=>{ if(cameraPresetSelect.value) loadCameraPreset(cameraPresetSelect.value); };
cameraPresetSelect.addEventListener('change',reloadSelectedCameraPreset);
cameraPresetSelect.addEventListener('pointerdown',reloadSelectedCameraPreset);
cameraPresetSelect.addEventListener('keydown',event=>{ if(['Enter',' '].includes(event.key)) reloadSelectedCameraPreset(); });
document.querySelector('#renameCamera').addEventListener('click',()=>{ const id=cameraPresetSelect.value, name=document.querySelector('#cameraName').value.trim(); if(!id||!name)return; const presets=readCameraPresets(), preset=presets.find(p=>p.id===id); if(!preset)return; preset.name=name; writeCameraPresets(presets); refreshCameraPresets(id); document.querySelector('.hint').textContent=`机位已更名为 ${name}`; });
document.querySelector('#deleteCamera').addEventListener('click',()=>{ const id=cameraPresetSelect.value; if(!id)return; const presets=readCameraPresets(), deleted=presets.find(p=>p.id===id); writeCameraPresets(presets.filter(p=>p.id!==id)); refreshCameraPresets(); document.querySelector('.hint').textContent=deleted?`已删除 ${deleted.name}`:'机位已删除'; });

const modelPanel=document.querySelector('#modelPanel'), outputPanel=document.querySelector('#outputPanel'), outputOverlay=document.querySelector('#outputOverlay'), outputFrame=document.querySelector('#outputFrame'), outputPreset=document.querySelector('#outputPreset'), outputRatio=document.querySelector('#outputRatio'), outputWidth=document.querySelector('#outputWidth'), outputHeight=document.querySelector('#outputHeight'); let outputDirectoryHandle;
const ratioValue=()=>{ const [w,h]=outputRatio.value.split(':').map(Number); return w/h; };
function updateOutputFrame(){ const width=Math.max(64,Number(outputWidth.value)||64), height=Math.max(64,Number(outputHeight.value)||64); outputFrame.style.aspectRatio=`${width} / ${height}`; }
function updateOutputDimensions(){ if(outputPreset.value!=='custom'){ const edge=Number(outputPreset.value), ratio=ratioValue(); if(ratio>=1){ outputWidth.value=String(edge); outputHeight.value=String(Math.round(edge/ratio)); }else{ outputHeight.value=String(edge); outputWidth.value=String(Math.round(edge*ratio)); } } updateOutputFrame(); }
function setOutputMode(enabled){
  if(planEditor?.enabled){
    modelPanel.hidden=enabled;
    planEditor.setPanelVisible(!enabled);
  }else modelPanel.hidden=enabled;
  outputPanel.hidden=!enabled;
  outputOverlay.hidden=!enabled;
  document.querySelector('#outputView').setAttribute('aria-pressed',String(enabled));
  if(enabled){ updateOutputDimensions(); document.querySelector('.hint').textContent='九宫格内为图片输出范围 · 调整视图完成构图'; }
  else document.querySelector('.hint').textContent=planEditor?.enabled?'编辑状态已恢复 · 可继续选择和调整物体':'拖动旋转 · 滚轮缩放 · 中键平移';
}
outputPreset.addEventListener('change',updateOutputDimensions); outputRatio.addEventListener('change',updateOutputDimensions); [outputWidth,outputHeight].forEach(input=>input.addEventListener('input',()=>{ outputPreset.value='custom'; updateOutputFrame(); })); document.querySelector('#outputView').addEventListener('click',()=>setOutputMode(outputPanel.hidden)); document.querySelector('#closeOutput').addEventListener('click',()=>setOutputMode(false));
document.querySelector('#chooseFolder').addEventListener('click',async()=>{ if(!window.showDirectoryPicker){ document.querySelector('#folderName').textContent='当前浏览器使用默认下载目录'; return; } try{ outputDirectoryHandle=await window.showDirectoryPicker({mode:'readwrite'}); document.querySelector('#folderName').textContent=outputDirectoryHandle.name; }catch(error){ if(error.name!=='AbortError')document.querySelector('#folderName').textContent='位置选择失败'; } });
async function renderOutputBlob(width,height){ const source=renderer.domElement, canvasRect=source.getBoundingClientRect(), frameRect=outputFrame.getBoundingClientRect(), oldSize=renderer.getSize(new THREE.Vector2()), oldRatio=renderer.getPixelRatio(), nx=(frameRect.left-canvasRect.left)/canvasRect.width, ny=(frameRect.top-canvasRect.top)/canvasRect.height, nw=frameRect.width/canvasRect.width, nh=frameRect.height/canvasRect.height, renderWidth=Math.ceil(width/nw), renderHeight=Math.ceil(height/nh); renderer.setPixelRatio(1); renderer.setSize(renderWidth,renderHeight,false); renderer.render(scene,activeCamera); const outputCanvas=document.createElement('canvas'); outputCanvas.width=width; outputCanvas.height=height; const context=outputCanvas.getContext('2d'); context.drawImage(source,Math.round(nx*renderWidth),Math.round(ny*renderHeight),Math.round(nw*renderWidth),Math.round(nh*renderHeight),0,0,width,height); const blob=await new Promise((resolve,reject)=>outputCanvas.toBlob(value=>value?resolve(value):reject(new Error('PNG output failed')),'image/png')); renderer.setPixelRatio(oldRatio); renderer.setSize(oldSize.x,oldSize.y,false); renderer.render(scene,activeCamera); return blob; }
document.querySelector('#saveImage').addEventListener('click',async event=>{ const button=event.currentTarget, width=Math.min(8192,Math.max(64,Number(outputWidth.value))), height=Math.min(8192,Math.max(64,Number(outputHeight.value))), filename=`eroom-${activeModel.id}-${Date.now()}.png`; button.disabled=true; button.textContent='正在生成…'; try{ const blob=await renderOutputBlob(width,height); if(outputDirectoryHandle){ const file=await outputDirectoryHandle.getFileHandle(filename,{create:true}), writable=await file.createWritable(); await writable.write(blob); await writable.close(); document.querySelector('.hint').textContent=`已保存 ${filename}`; }else{ const url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url; link.download=filename; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); document.querySelector('.hint').textContent=`已输出 ${width} × ${height} PNG`; } }catch(error){ console.error(error); document.querySelector('.hint').textContent='图片输出失败，请降低尺寸后重试'; }finally{ button.disabled=false; button.textContent='保存 PNG'; } });
const box = (name, size, position, material, parent, options = {}) => { const geometry = new THREE.BoxGeometry(...size); const mesh = new THREE.Mesh(geometry, material); mesh.name = name; mesh.position.set(...position); mesh.castShadow = options.castShadow ?? true; mesh.receiveShadow = options.receiveShadow ?? true; if (options.rotationY) mesh.rotation.y = options.rotationY; parent.add(mesh); if (options.edges) { const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMat); outline.userData.perspectiveOutline = true; outline.visible = activeCamera===topCamera||perspectiveOutlinesInput.checked; mesh.add(outline); } return mesh; };
function makeWall(side, model) { const horizontal = side === 'north' || side === 'south', length = horizontal ? model.width : model.depth, g = new THREE.Group(); g.name = `${side}-wall`; walls[side] = g; architecture.add(g); const openings = [...(model.windows || []).filter(x => x.wall === side).map(x => ({...x, kind:'window'})), ...(model.doors || []).filter(x => x.wall === side).map(x => ({...x, kind:'door'}))].sort((a,b) => a.offset - b.offset); let cursor = -length / 2; const addSegment = (center, span, y, height) => { const pos = horizontal ? [center,y,side === 'north' ? -model.depth/2 : model.depth/2] : [side === 'west' ? -model.width/2 : model.width/2,y,center]; box('wall-segment', horizontal ? [span,height,model.wall] : [model.wall,height,span], pos, mats.wall, g, {edges:true}); if(Math.abs(y+height/2-model.height)<0.001){ const across=model.wall/2+0.003, points=horizontal?[new THREE.Vector3(center-span/2,model.height-0.006,pos[2]-across),new THREE.Vector3(center+span/2,model.height-0.006,pos[2]-across),new THREE.Vector3(center-span/2,model.height-0.006,pos[2]+across),new THREE.Vector3(center+span/2,model.height-0.006,pos[2]+across)]:[new THREE.Vector3(pos[0]-across,model.height-0.006,center-span/2),new THREE.Vector3(pos[0]-across,model.height-0.006,center+span/2),new THREE.Vector3(pos[0]+across,model.height-0.006,center-span/2),new THREE.Vector3(pos[0]+across,model.height-0.006,center+span/2)]; const seam=new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),edgeMat); seam.userData.perspectiveOutline=true; seam.userData.ceilingSeam=true; architecture.add(seam); } }; openings.forEach(opening => { const start = opening.offset - opening.width/2; if(start > cursor) addSegment((cursor+start)/2,start-cursor,model.height/2,model.height); if(opening.kind === 'window'){ const sillHeight = Math.max(0, Number(opening.sillHeight ?? opening.bottomWallHeight ?? 0.66) || 0), openingHeight = Math.max(0.05, Number(opening.height) || 2.18), headerHeight = Math.max(0, model.height - sillHeight - openingHeight); addSegment(opening.offset,opening.width,sillHeight/2,sillHeight); if(headerHeight > 0) addSegment(opening.offset,opening.width,sillHeight + openingHeight + headerHeight/2,headerHeight); } else { const openingHeight = 2.1, headerHeight = Math.max(0, model.height - openingHeight); if(headerHeight > 0) addSegment(opening.offset,opening.width,openingHeight + headerHeight/2,headerHeight); } cursor = opening.offset + opening.width/2; }); if(cursor < length/2) addSegment((cursor+length/2)/2,length/2-cursor,model.height/2,model.height); }
function makeWindow(side, offset, width, model, sillHeight = 0.66, height = 2.18) { const horizontal = side === 'north' || side === 'south'; sillHeight = Math.max(0, Number(sillHeight) || 0); height = Math.max(0.05, Number(height) || 2.18); const pos = horizontal ? [offset, sillHeight + height / 2, side === 'north' ? -model.depth / 2 - 0.01 : model.depth / 2 + 0.01] : [side === 'west' ? -model.width / 2 - 0.01 : model.width / 2 + 0.01, sillHeight + height / 2, offset]; const g = new THREE.Group(); g.position.set(...pos); if (!horizontal) g.rotation.y = Math.PI / 2; box('glass', [width, height, 0.05], [0, 0, 0], mats.glass, g, { castShadow: false }); box('frame-top', [width + 0.08, 0.08, 0.12], [0, height / 2 + 0.03, 0], mats.frame, g); box('frame-bottom', [width + 0.08, 0.08, 0.12], [0, -height / 2 + 0.03, 0], mats.frame, g); box('mullion', [0.065, height, 0.12], [0, 0, 0], mats.frame, g); walls[side].add(g); }
function makeDoor(side, offset, width, model) { const horizontal = side === 'north' || side === 'south'; const pos = horizontal ? [offset, 1.05, side === 'north' ? -model.depth / 2 - 0.03 : model.depth / 2 + 0.03] : [side === 'west' ? -model.width / 2 - 0.03 : model.width / 2 + 0.03, 1.05, offset]; const g = new THREE.Group(); g.position.set(...pos); if (!horizontal) g.rotation.y = Math.PI / 2; const leaf = box('door', [width, 2.1, 0.08], [0, 0, 0], mats.oakDark, g, { edges: true }); leaf.rotation.y = 0.72; walls[side].add(g); }
function makeChair(item, parent) { const material = mats[item.material || 'cream'], [x,z] = item.position || [0,0]; const g = new THREE.Group(); g.position.set(x,0,z); g.rotation.y = item.rotation || 0; box('seat', [0.58,0.14,0.58], [0,0.52,0], material, g, {edges:true}); box('back', [0.58,0.72,0.13], [0,0.83,0.27], material, g, {edges:true}); for(const lx of [-0.23,0.23]) for(const lz of [-0.23,0.23]) box('leg',[0.08,0.5,0.08],[lx,0.25,lz],mats.metal,g); parent.add(g); }
function makeItem(item, parent) { const [x,z] = item.position || [0,0], size = item.size || [1,1], mat = mats[item.material || 'cream']; if(item.kind === 'chair') return makeChair(item,parent); if(item.kind === 'sofa'){ const g = new THREE.Group(); g.position.set(x,0,z); g.rotation.y = item.rotation || 0; box('base',[size[0],0.36,size[1]],[0,0.28,0],mats.rustDark,g,{edges:true}); box('cushion',[size[0]-0.08,0.22,size[1]-0.22],[0,0.56,-0.07],mat,g,{edges:true}); box('back',[size[0],0.82,0.2],[0,0.76,size[1]/2-0.1],mat,g,{edges:true}); box('arm-left',[0.16,0.62,size[1]],[-size[0]/2+0.08,0.55,0],mats.rustDark,g,{edges:true}); box('arm-right',[0.16,0.62,size[1]],[size[0]/2-0.08,0.55,0],mats.rustDark,g,{edges:true}); parent.add(g); return; } if(item.kind === 'tv'){ box('tv-screen',[0.08,size[1],size[0]],[x,1.12,z],mat,parent,{edges:true}); return; } if(item.kind === 'rug'){ box('rug',[size[0],0.06,size[1]],[x,0.055,z],mat,parent,{castShadow:false}); return; } if(item.kind === 'bench'){ box('bench',[size[0],0.46,size[1]],[x,0.29,z],mat,parent,{edges:true}); return; } const h = item.height || 0.45; if(item.kind === 'counter' || item.kind === 'island'){ box(`${item.kind}-base`,[size[0],h,size[1]],[x,h/2,z],mat,parent,{edges:true}); box(`${item.kind}-top`,[size[0]+0.05,0.08,size[1]+0.05],[x,h+0.04,z],mat,parent,{edges:true}); return; } if(item.kind === 'sink'){ box('sink',[size[0],0.12,size[1]],[x,h,z],mat,parent,{edges:true}); return; } box(`${item.kind}-top`,[size[0],0.12,size[1]],[x,h,z],mat,parent,{edges:true}); const px=Math.max(0.16,size[0]/2-0.18), pz=Math.max(0.16,size[1]/2-0.18); for(const lx of [-px,px]) for(const lz of [-pz,pz]) box('leg',[0.09,h,0.09],[x+lx,h/2,z+lz],mats.metal,parent); }
function clearScene() { const sharedMaterials=new Set([...Object.values(mats),ceilingMat,edgeMat]); [...architecture.children,...furniture.children].forEach(root=>root.traverse(object=>{ object.geometry?.dispose(); const materials=Array.isArray(object.material)?object.material:[object.material]; materials.filter(material=>material&&!sharedMaterials.has(material)).forEach(material=>material.dispose()); })); architecture.clear(); furniture.clear(); ceiling=undefined; Object.keys(walls).forEach(k => delete walls[k]); }
function renderModel(model) { sun.castShadow=sunEnabled; clearScene(); box('floor', [model.width + 0.44,0.18,model.depth + 0.44], [0,-0.09,0], mats.floor, architecture, {edges:true}); box('finish',[model.width-0.12,0.025,model.depth-0.12],[0,0.015,0],mats.floorInset,architecture,{castShadow:false}); const ceilingBaseColor=new THREE.Color(model.editor?.ceilingColor||'#e9e6dc'); const ceilingGray=Math.min(1,Math.max(0,Number(model.editor?.ceilingGray)||0)); if(ceilingGray>0){ const luminance=ceilingBaseColor.r*0.299+ceilingBaseColor.g*0.587+ceilingBaseColor.b*0.114; ceilingBaseColor.lerp(new THREE.Color(luminance,luminance,luminance),ceilingGray); } ceilingMat.color.copy(ceilingBaseColor); ceiling=box('ceiling',[model.width+0.44,0.16,model.depth+0.44],[0,model.height+0.08,0],ceilingMat,architecture,{edges:true}); ceiling.visible=Boolean(model.ceilingVisible); ['north','south','east','west'].forEach(side=>makeWall(side,model)); (model.windows||[]).forEach(w=>makeWindow(w.wall,w.offset,w.width,model,w.sillHeight ?? w.bottomWallHeight ?? 0.66,w.height ?? 2.18)); (model.doors||[]).forEach(d=>makeDoor(d.wall,d.offset,d.width,model)); (model.zones||[]).forEach(zone=>{ const [x,z]=zone.position||[0,0], g=new THREE.Group(); g.name=zone.id; g.position.set(x,0,z); furniture.add(g); zone.items.forEach(item=>makeItem(item,g)); }); activeCamera=camera; controls.object=camera; controls.enableRotate=true; controls.minDistance=0.2; controls.maxDistance=120; controls.target.set(0,0.7,0); camera.position.set(model.width*0.83,model.height*2.9,model.depth*1.8); controls.update(); updatePerspectiveOutlines(); document.querySelector('.hint').textContent='拖动旋转 · 滚轮缩放 · 中键平移'; updatePanel(model); invalidateShadows(); renderer.render(scene,activeCamera); }
function updatePanel(model) {
  document.querySelector('#modelName').textContent = model.name;
  document.querySelector('#roomSize').textContent = `${model.width.toFixed(2)} × ${model.depth.toFixed(2)} m`;
  document.querySelector('#roomHeight').textContent = `${model.height.toFixed(1)} m`;
  document.querySelector('#roomHeightInput').value = model.height.toFixed(1);
  document.querySelector('#scaleLabel').textContent = `${Math.round(Math.min(model.width, model.depth) / 2)} m`;
  const legend = document.querySelector('#legend');
  legend.innerHTML = '';
  (model.zones || []).forEach(zone => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.focus = zone.id;
    button.innerHTML = `<i class="swatch ${zone.color || 'core'}"></i>${zone.name}`;
    button.addEventListener('click', () => focusZone(zone));
    legend.appendChild(button);
  });
  const usesEditorScene = Array.isArray(model.editor?.items);
  const editorWalls = usesEditorScene ? planEditor.getWallVisibility() : null;
  document.querySelectorAll('[data-wall]').forEach(button => {
    const side = button.dataset.wall;
    button.setAttribute('aria-pressed', String(usesEditorScene ? editorWalls[side] : true));
    button.onclick = () => {
      const visible = usesEditorScene ? planEditor.setWallVisibility(side, !planEditor.getWallVisibility()[side]) : (walls[side].visible = !walls[side].visible);
      button.setAttribute('aria-pressed', String(visible));
      renderer.render(scene, activeCamera);
    };
  });
  const quickHideButton = document.querySelector('#quickHideToggle');
  const quickShowButton = document.querySelector('#quickShowToggle');
  quickHideButton.setAttribute('aria-pressed', String(planEditor.getQuickHideMode?.() || false));
  quickHideButton.onclick = () => {
    const active = planEditor.toggleQuickHideMode();
    quickHideButton.setAttribute('aria-pressed', String(active));
    updatePanel(activeModel);
    quickHideButton.title = active ? '点击图面选择要隐藏的构件，再点“隐”退出隐藏选择' : '点击后选择需要隐藏的构件';
    if (active) document.querySelector('.hint').textContent = '隐 · 点击图面选择构件隐藏，再点“隐”恢复全部';
  };
  quickShowButton.onclick = () => { planEditor.clearQuickHidden?.(); quickHideButton.setAttribute('aria-pressed', 'false'); document.querySelector('.hint').textContent = '已显示全部隐藏构件'; };
  const ceilingButton = document.querySelector('#ceilingToggle');
  ceilingButton.setAttribute('aria-pressed', String(usesEditorScene ? planEditor.getCeilingVisibility() : false));
  ceilingButton.onclick = () => {
    const visible = usesEditorScene ? planEditor.setCeilingVisibility(!planEditor.getCeilingVisibility()) : (activeModel.ceilingVisible = ceiling.visible = !ceiling.visible);
    ceilingButton.setAttribute('aria-pressed', String(visible));
    updatePerspectiveOutlines();
    renderer.render(scene, activeCamera);
  };
}
function focusZone(zone) { const [x, z] = zone.position; moveCamera([x + 4.5, 4.8, z + 5.5], [x, 0.6, z]); }
function moveCamera(position, target, duration = 700) { sun.castShadow=sunEnabled; activeCamera=camera; controls.object=camera; controls.enableRotate=true; const from = camera.position.clone(), fromTarget = controls.target.clone(), to = new THREE.Vector3(...position), toTarget = new THREE.Vector3(...target), start = performance.now(); function tick(now) { const t = Math.min((now - start) / duration, 1), e = 1 - Math.pow(1 - t, 3); camera.position.lerpVectors(from, to, e); controls.target.lerpVectors(fromTarget, toTarget, e); controls.update(); renderer.render(scene, activeCamera); if (t < 1) requestAnimationFrame(tick); } requestAnimationFrame(tick); }
function showTopView(){ sun.castShadow=false; const aspect=innerWidth/innerHeight, margin=1.8, viewHeight=Math.max(activeModel.depth+margin,(activeModel.width+margin)/aspect), offsetX=-0.9; topCamera.left=-viewHeight*aspect/2; topCamera.right=viewHeight*aspect/2; topCamera.top=viewHeight/2; topCamera.bottom=-viewHeight/2; topCamera.updateProjectionMatrix(); topCamera.position.set(offsetX,20,0); topCamera.up.set(0,0,-1); topCamera.lookAt(offsetX,0,0); activeCamera=topCamera; controls.object=topCamera; controls.enableRotate=false; controls.target.set(offsetX,0,0); controls.update(); updatePerspectiveOutlines(); document.querySelector('.hint').textContent='拖动平移 · 滚轮缩放 · 正交无透视'; renderer.render(scene,activeCamera); }
function showCameraView(){ sun.castShadow=sunEnabled; activeCamera=camera; controls.object=camera; controls.enableRotate=true; controls.minDistance=0.05; controls.maxDistance=120; camera.position.set(0,1.65,activeModel.depth/2-0.65); controls.target.set(0,1.45,-1); controls.update(); updatePerspectiveOutlines(); document.querySelector('.hint').textContent='拖动改变拍摄方向 · 中键平移 · 滚轮调整距离'; renderer.render(scene,activeCamera); }
scene.add(new THREE.HemisphereLight(0xf4f1e9, 0x8a918b, 1.45)); const ambientLight = new THREE.AmbientLight(0xffffff,0.8); scene.add(ambientLight); const sun = new THREE.DirectionalLight(0xfff3dc, 2.35); sun.castShadow = true; sun.shadow.mapSize.set(2048,2048); sun.shadow.camera.left=-12; sun.shadow.camera.right=12; sun.shadow.camera.top=12; sun.shadow.camera.bottom=-12; sun.shadow.camera.near=0.5; sun.shadow.camera.far=50; sun.shadow.bias=-0.00025; sun.shadow.normalBias=0.035; sun.shadow.radius=3; scene.add(sun); scene.add(sun.target); const fill = new THREE.DirectionalLight(0xa9d2cf,0.72); fill.position.set(8,6,-8); scene.add(fill);
const sunXInput=document.querySelector('#sunX'), sunZInput=document.querySelector('#sunZ'), sunElevationInput=document.querySelector('#sunElevation'), sunIntensityInput=document.querySelector('#sunIntensity'), sunIntensityValue=document.querySelector('#sunIntensityValue'), sunToggleInput=document.querySelector('#sunEnabled'), ambientIntensityInput=document.querySelector('#ambientIntensity'), ambientIntensityValue=document.querySelector('#ambientIntensityValue'), perspectiveOutlinesInput=document.querySelector('#perspectiveOutlines');
function updateSunIntensity(){ const intensity=Number(sunIntensityInput.value); sun.intensity=intensity; sunIntensityValue.textContent=intensity.toFixed(2); invalidateShadows(); renderer.render(scene,activeCamera); }
function updateAmbientLight(){ const intensity=Number(ambientIntensityInput.value); ambientLight.intensity=intensity; ambientIntensityValue.textContent=intensity.toFixed(2); renderer.render(scene,activeCamera); }
function updatePerspectiveOutlines(){ const visible=activeCamera===topCamera||perspectiveOutlinesInput.checked; perspectiveOutlinesInput.nextElementSibling.textContent=perspectiveOutlinesInput.checked?'显示':'隐藏'; architecture.traverse(object=>{ if(object.userData.perspectiveOutline)object.visible=visible&&(!object.userData.ceilingSeam||Boolean(ceiling?.visible)); }); furniture.traverse(object=>{ if(object.userData.perspectiveOutline)object.visible=visible; }); planEditor?.refreshOutlines?.(); renderer.render(scene,activeCamera); }
function updateSunPosition(){ const x=Number(sunXInput.value), z=Number(sunZInput.value), elevation=Number(sunElevationInput.value), length=Math.hypot(x,z)||1, distance=18, radians=THREE.MathUtils.degToRad(elevation), horizontal=distance*Math.cos(radians); sun.position.set(x/length*horizontal,distance*Math.sin(radians),z/length*horizontal); sun.target.position.set(0,0,0); sun.target.updateMatrixWorld(); document.querySelector('#sunXValue').textContent=String(x); document.querySelector('#sunZValue').textContent=String(z); document.querySelector('#sunElevationValue').textContent=`${elevation}°`; sun.visible=sunEnabled; sun.castShadow=sunEnabled&&activeCamera!==topCamera; invalidateShadows(); renderer.render(scene,activeCamera); }
[sunXInput,sunZInput,sunElevationInput].forEach(input=>input.addEventListener('input',updateSunPosition)); sunIntensityInput.addEventListener('input',updateSunIntensity); sunToggleInput.addEventListener('change',()=>{ sunEnabled=sunToggleInput.checked; sunToggleInput.nextElementSibling.textContent=sunEnabled?'开启':'关闭'; updateSunPosition(); }); ambientIntensityInput.addEventListener('input',updateAmbientLight); perspectiveOutlinesInput.addEventListener('change',updatePerspectiveOutlines); updateSunIntensity(); updateAmbientLight(); updateSunPosition();
const PERSPECTIVE_AZIMUTHS = { 45: '东南', 135: '东北', 315: '西南', 225: '西北' };
const PERSPECTIVE_POLAR_DEG = 52; // 相机相对竖直方向的极角，约 38° 俯视，符合 3D 软件习惯
function setCameraAzimuth(azimuthDeg) {
  const size = Math.max(activeModel.width, activeModel.depth);
  const targetY = Math.max(activeModel.height * 0.42, 1.2);
  const radius = size * 1.15 + 4.5;
  const polar = THREE.MathUtils.degToRad(PERSPECTIVE_POLAR_DEG);
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  camera.position.set(
    Math.sin(azimuth) * radius * Math.sin(polar),
    targetY + radius * Math.cos(polar),
    Math.cos(azimuth) * radius * Math.sin(polar)
  );
  controls.object = camera;
  controls.enableRotate = true;
  controls.minDistance = 0.2;
  controls.maxDistance = 120;
  controls.target.set(0, targetY, 0);
  camera.lookAt(controls.target);
  controls.update();
  activeCamera = camera;
  updatePerspectiveOutlines();
  renderer.render(scene, activeCamera);
}
function enterPerspectiveView(azimuthDeg = 45) {
  if (!activeModel) return;
  if (!outputPanel.hidden) setOutputMode(false);
  activeModel.ceilingVisible = false;
  if (activeModel.editor) activeModel.editor.ceilingVisible = false;
  document.querySelector('#ceilingToggle').setAttribute('aria-pressed', 'false');
  renderModel(activeModel);
  setCameraAzimuth(azimuthDeg);
  if (planEditor.enabled) {
    planEditor.setCeilingVisibility(false);
    planEditor.setPerspectiveView();
  } else planEditor.refresh();
  document.querySelector('.hint').textContent = `${PERSPECTIVE_AZIMUTHS[azimuthDeg] || '东南'}视角 · 拖动旋转 · 滚轮缩放 · 中键平移`;
}
const perspectiveMenu = document.querySelector('#perspectiveMenu');
const perspectiveDropdown = document.querySelector('.view-dropdown');
let perspectiveMenuTimer;
function showPerspectiveMenu() { clearTimeout(perspectiveMenuTimer); perspectiveMenu.hidden = false; }
function hidePerspectiveMenu() { perspectiveMenuTimer = setTimeout(() => { perspectiveMenu.hidden = true; }, 180); }
document.querySelector('#resetView').addEventListener('mouseenter', showPerspectiveMenu);
perspectiveMenu.addEventListener('mouseenter', showPerspectiveMenu);
perspectiveDropdown.addEventListener('mouseleave', hidePerspectiveMenu);
perspectiveMenu.querySelectorAll('button').forEach(button => {
  button.addEventListener('click', () => {
    perspectiveMenu.hidden = true;
    enterPerspectiveView(Number(button.dataset.azimuth));
  });
});
document.querySelector('#resetView').addEventListener('click', () => enterPerspectiveView(45));
document.querySelector('#topView').addEventListener('click', () => { if (activeModel) { if(!outputPanel.hidden)setOutputMode(false); if(planEditor.enabled)planEditor.setTopView(); else showTopView(); } });
document.querySelector('#cameraView').addEventListener('click', () => { if(activeModel) recordCameraPreset(); });
const focalInput=document.querySelector('#focalLength'), focalValue=document.querySelector('#focalValue');
focalInput.addEventListener('input',()=>{ const focal=Number(focalInput.value); camera.setFocalLength(focal); focalValue.textContent=`${focal} mm`; if(activeCamera===camera) renderer.render(scene,activeCamera); });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); if(activeCamera===topCamera) showTopView(); else renderer.render(scene,activeCamera); });
controls.addEventListener('change', () => renderer.render(scene,activeCamera));
let activeModel;
let loadedModels = [];
const select = document.querySelector('#modelSelect');
const modelPicker = document.querySelector('#modelPicker');
const modelPickerButton = document.querySelector('#modelPickerButton');
const modelPickerLabel = document.querySelector('#modelPickerLabel');
const modelPickerMenu = document.querySelector('#modelPickerMenu');
const roomHeightInput = document.querySelector('#roomHeightInput');
const dataFileButton = document.querySelector('#dataFileButton');
const dataFileInput = document.querySelector('#dataFileInput');
const spaceDialog = document.querySelector('#spaceDialog');
const saveDialog = document.querySelector('#saveDialog');
const planEditor = createPlanEditor({
  scene,
  renderer,
  controls,
  architecture,
  furniture,
  getCamera: () => activeCamera,
  getActiveModel: () => activeModel,
  getModels: () => loadedModels,
  showTopView,
  syncPanel: () => updatePanel(activeModel),
  renderScene: () => renderer.render(scene, activeCamera),
  invalidateShadows,
  getPerspectiveOutlines: () => perspectiveOutlinesInput.checked,
  requestSave: () => saveDialog.showModal(),
  cameraView: item => {
    activeCamera = camera;
    controls.object = camera;
    controls.enableRotate = true;
    controls.minDistance = 0.05;
    controls.maxDistance = 120;
    camera.position.set(item.position[0], item.cameraHeight || 1.65, item.position[1]);
    const target = item.target || [item.position[0], item.position[1] - 1];
    controls.target.set(target[0], item.cameraHeight || 1.65, target[1]);
    camera.setFocalLength(item.focalLength || 35);
    focalInput.value = String(item.focalLength || 35);
    focalValue.textContent = String(item.focalLength || 35) + ' mm';
    controls.update();
    planEditor.setPerspectiveView();
    renderer.render(scene, activeCamera);
    document.querySelector('.hint').textContent = '已切换到编辑器相机视角';
  }
});

function modelId(model, index) {
  return model.id || `model-${index + 1}`;
}

function closeModelPicker() {
  modelPickerMenu.hidden = true;
  modelPickerButton.setAttribute('aria-expanded', 'false');
}

function activateModel(model) {
  if (!model) return;
  activeModel = model;
  select.value = modelId(model, loadedModels.indexOf(model));
  modelPickerLabel.textContent = model.name || `模型 ${loadedModels.indexOf(model) + 1}`;
  refreshCameraPresets();
  refreshModelPicker();
  renderModel(activeModel);
  planEditor.refresh();
}

function refreshModelPicker() {
  modelPickerMenu.innerHTML = '';
  loadedModels.forEach((model, index) => {
    const id = modelId(model, index);
    const item = document.createElement('div');
    item.className = 'model-picker-item';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(model === activeModel));

    const chooseButton = document.createElement('button');
    chooseButton.className = 'model-picker-option';
    chooseButton.type = 'button';
    chooseButton.textContent = model.name || `模型 ${index + 1}`;
    chooseButton.addEventListener('click', () => {
      closeModelPicker();
      activateModel(model);
    });

    const deleteButton = document.createElement('button');
    deleteButton.className = 'model-picker-delete';
    deleteButton.type = 'button';
    deleteButton.textContent = '×';
    deleteButton.setAttribute('aria-label', `删除空间 ${chooseButton.textContent}`);
    deleteButton.title = `删除 ${chooseButton.textContent}`;
    deleteButton.addEventListener('click', event => {
      event.stopPropagation();
      deleteModel(id);
    });

    item.append(chooseButton, deleteButton);
    modelPickerMenu.appendChild(item);
  });
  modelPickerLabel.textContent = activeModel?.name || '选择空间';
}

function populateModels(models, fileName = 'models.json', selectedId = '') {
  loadedModels = models;
  const legacyPresets = readLegacyCameraPresets();
  loadedModels.forEach((model, index) => {
    model.id ||= modelId(model, index);
    if (!Array.isArray(model.cameraPresets)) model.cameraPresets = legacyPresets.filter(preset => preset.modelId === model.id).map(preset => ({ ...preset }));
    model.ceilingVisible ??= false;
    if (model.editor) model.editor.ceilingVisible ??= model.ceilingVisible;
  });
  select.innerHTML = '';
  loadedModels.forEach((model, index) => {
    const option = document.createElement('option');
    option.value = modelId(model, index);
    option.textContent = model.name || `模型 ${index + 1}`;
    select.appendChild(option);
  });
  dataFileButton.textContent = fileName;
  dataFileButton.title = fileName;
  activateModel(loadedModels.find((model, index) => modelId(model, index) === selectedId) || loadedModels[0]);
}

function deleteModel(id) {
  if (loadedModels.length <= 1) {
    closeModelPicker();
    document.querySelector('.hint').textContent = '至少需要保留一个空间';
    return;
  }
  const index = loadedModels.findIndex((model, modelIndex) => modelId(model, modelIndex) === id);
  if (index < 0) return;
  const model = loadedModels[index];
  const name = model.name || `模型 ${index + 1}`;
  if (!window.confirm(`确定删除空间“${name}”吗？\n删除后，再次保存到系统会从 models.json 中移除。`)) return;
  const nextModels = loadedModels.filter((_, modelIndex) => modelIndex !== index);
  const nextActive = model === activeModel ? nextModels[Math.min(index, nextModels.length - 1)] : activeModel;
  const nextActiveId = nextActive ? modelId(nextActive, nextModels.indexOf(nextActive)) : '';
  populateModels(nextModels, dataFileButton.textContent, nextActiveId);
  closeModelPicker();
  document.querySelector('.hint').textContent = `已删除“${name}”，保存到系统后将同步更新 models.json`;
}

modelPickerButton.addEventListener('click', () => {
  const willOpen = modelPickerMenu.hidden;
  modelPickerMenu.hidden = !willOpen;
  modelPickerButton.setAttribute('aria-expanded', String(willOpen));
});
document.addEventListener('click', event => {
  if (!modelPicker.contains(event.target)) closeModelPicker();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeModelPicker();
});

function slugify(value) {
  return String(value || 'space').trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'space';
}

function uniqueModelId(value, reserved = new Set(loadedModels.map(model => model.id))) {
  const base = slugify(value);
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate)) candidate = base + '-' + suffix++;
  reserved.add(candidate);
  return candidate;
}

function normalizeImportedModels(data) {
  const source = Array.isArray(data?.models) ? data.models : data && typeof data === 'object' ? [data] : [];
  if (!source.length) throw new Error('JSON 中没有可用模型');
  const reserved = new Set(loadedModels.map(model => model.id));
  return source.map((model, index) => {
    const copy = JSON.parse(JSON.stringify(model));
    copy.name ||= '导入空间 ' + (index + 1);
    copy.id = uniqueModelId(copy.id || copy.name, reserved);
    copy.width = Number(copy.width) || 10;
    copy.depth = Number(copy.depth) || 8;
    copy.height = Number(copy.height) || 3.6;
    copy.wall = Number(copy.wall) || 0.22;
    copy.windows ||= [];
    copy.doors ||= [];
    copy.zones ||= [];
    return copy;
  });
}

function appendModels(models, fileName) {
  loadedModels = [...loadedModels, ...models];
  populateModels(loadedModels, fileName || dataFileButton.textContent, models[0].id);
  document.querySelector('.hint').textContent = '已添加 ' + models.length + ' 个空间到列表';
}

async function saveJsonFile(content, suggestedName) {
  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({ suggestedName, types: [{ description: 'JSON 模型数据', accept: { 'application/json': ['.json'] } }] });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return;
  }
  const blob = new Blob([content], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = suggestedName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function saveCurrentAsJson() {
  if (!activeModel) return;
  await saveJsonFile(JSON.stringify({ models: [activeModel] }, null, 2), slugify(activeModel.name || activeModel.id) + '.json');
  document.querySelector('.hint').textContent = '当前空间已另存为 JSON';
}

async function saveModelsToSystem() {
  const response = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: loadedModels }, null, 2) });
  if (!response.ok) throw new Error(await response.text() || '系统保存失败');
  dataFileButton.textContent = 'models.json';
  dataFileButton.title = 'models.json';
  document.querySelector('.hint').textContent = '已保存到 public/models.json';
}

const spaceNameInput = document.querySelector('#spaceNameInput');
const spaceJsonInput = document.querySelector('#spaceJsonInput');
const spaceJsonName = document.querySelector('#spaceJsonName');
document.querySelector('#newSpace').addEventListener('click', () => {
  spaceNameInput.value = '';
  spaceJsonInput.value = '';
  spaceJsonName.textContent = '未选择文件';
  spaceDialog.showModal();
  setTimeout(() => spaceNameInput.focus(), 0);
});
spaceJsonInput.addEventListener('change', () => { spaceJsonName.textContent = spaceJsonInput.files?.[0]?.name || '未选择文件'; });
document.querySelector('#spaceForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { spaceDialog.close(); return; }
  try {
    const file = spaceJsonInput.files?.[0];
    if (file) {
      const models = normalizeImportedModels(JSON.parse(await file.text()));
      appendModels(models, dataFileButton.textContent);
    } else {
      const name = spaceNameInput.value.trim();
      if (!name) { spaceNameInput.focus(); document.querySelector('.hint').textContent = '请填写空间名称或选择 JSON'; return; }
      const model = { id: uniqueModelId(name), name, width: 10, depth: 8, height: 3.6, wall: 0.22, windows: [], doors: [], zones: [], editor: { version: 6, items: [], emptySpace: true } };
      appendModels([model], dataFileButton.textContent);
    }
    spaceDialog.close();
    planEditor.enter();
  } catch (error) {
    console.error(error);
    document.querySelector('.hint').textContent = '无法新增空间：' + error.message;
  }
});

document.querySelector('#saveForm').addEventListener('submit', async event => {
  event.preventDefault();
  const action = event.submitter?.value;
  if (action === 'cancel') { saveDialog.close(); return; }
  const button = event.submitter;
  button.disabled = true;
  try {
    if (action === 'save-as') await saveCurrentAsJson();
    if (action === 'save-system') await saveModelsToSystem();
    saveDialog.close();
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      document.querySelector('.hint').textContent = '保存失败：' + error.message;
    }
  } finally {
    button.disabled = false;
  }
});

select.addEventListener('change', () => {
  activateModel(loadedModels.find((model, index) => modelId(model, index) === select.value));
});

let roomHeightTimer;
function applyRoomHeight(clampValue = false) {
  if (!activeModel) return;
  let height = Number(roomHeightInput.value);
  if (!Number.isFinite(height) || (!clampValue && (height < 2 || height > 12))) return;
  height = Math.min(12, Math.max(2, height || activeModel.height));
  if (height === activeModel.height) return;
  const previousHeight = activeModel.height;
  planEditor.pushHistory();
  activeModel.height = Math.round(height * 10) / 10;
  planEditor.syncRoomHeight(activeModel.height, previousHeight);
  renderModel(activeModel);
  planEditor.refresh();
  document.querySelector('.hint').textContent = `层高已调整为 ${activeModel.height.toFixed(1)} m`;
}
roomHeightInput.addEventListener('input', () => {
  clearTimeout(roomHeightTimer);
  roomHeightTimer = setTimeout(() => applyRoomHeight(false), 180);
});
roomHeightInput.addEventListener('change', () => {
  clearTimeout(roomHeightTimer);
  applyRoomHeight(true);
});

dataFileButton.addEventListener('click', () => dataFileInput.click());
dataFileInput.addEventListener('change', async () => {
  const file = dataFileInput.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.models) || data.models.length === 0) throw new Error('JSON 中没有可用的 models 数组');
    populateModels(data.models, file.name);
    document.querySelector('.hint').textContent = `已加载 ${file.name} · ${data.models.length} 个模型`;
  } catch (error) {
    console.error(error);
    document.querySelector('.hint').textContent = `无法加载 ${file.name}，请检查 JSON 格式`;
  } finally {
    dataFileInput.value = '';
  }
});

fetch(`/models.json?v=${Date.now()}`, { cache: 'no-store' })
  .then(response => {
    if (!response.ok) throw new Error(`模型数据请求失败：${response.status}`);
    return response.json();
  })
  .then(data => {
    if (!Array.isArray(data.models) || data.models.length === 0) throw new Error('models.json 中没有可用模型');
    populateModels(data.models);
    document.querySelector('#loading').classList.add('done');
  })
  .catch(error => {
    console.error(error);
    document.querySelector('#loading').textContent = '模型数据加载失败';
  });

