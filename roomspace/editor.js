import * as THREE from 'three';

const TYPES = {
  background: { label: '底图', method: 'asset' },
  floor: { label: '地板', method: 'polygon', offset: 0.3, height: 0.1 },
  camera: { label: '相机', method: 'camera', focalLength: 35, cameraHeight: 1.65 },
  door: { label: '门', method: 'direction', length: 0.9, width: 0.16, height: 2.1, openAngle: 0 },
  window: { label: '窗', method: 'length', length: 1.4, width: 0.12, height: 1.5, sillHeight: 0.66 },
  curtainWall: { label: '玻璃幕墙', method: 'length', length: 3, width: 0.12, height: 3.6, sillHeight: 0 },
  wall: { label: '墙', method: 'length', length: 3, width: 0.22, height: 3.6 },
  pillar: { label: '柱', method: 'direction', length: 0.4, width: 0.4, height: 3.6, pillarShape: 'square' },
  cube: { label: '立方体', method: 'direction', length: 1, width: 1, height: 1 },
  cylinder: { label: '圆柱体', method: 'direction', length: 1, width: 1, height: 1 },
  table: { label: '桌子', method: 'length', length: 1.4, width: 0.8, height: 0.76 },
  lShapedOfficeDesk: { label: 'L型办公桌', method: 'length', length: 2.4, width: 1.8, height: 1.39, deskHeight: 0.78, deskDepth: 0.75, screenHeight: 0.55, chairOffset: 0.42 },
  chair: { label: '椅子', method: 'direction', length: 0.58, width: 0.58, height: 1.19 },
  coffeeTable: { label: '茶几', method: 'length', length: 0.9, width: 0.55, height: 0.42, shape: 'rectangular' },
  sofa: { label: '沙发', method: 'length', length: 2.1, width: 0.85, height: 1.17 },
  backlessSofa: { label: '无靠背沙发', method: 'length', length: 1.6, width: 0.65, height: 0.52, shape: 'rectangular' },
  other: { label: '其他', method: 'direction', length: 1, width: 0.6, height: 0.8 }
};

const TYPE_COLORS = {
  wall: 0x40534a, window: 0x4e98a5, curtainWall: 0x3f8792, door: 0x8a5735, pillar: 0x59645f,
  table: 0x9d6b45, lShapedOfficeDesk: 0x9d6b45, chair: 0xc17654, coffeeTable: 0xb49670, sofa: 0xa34d32,
  backlessSofa: 0x678c87, other: 0x59645f, cube: 0x78909c, cylinder: 0x78909c, floor: 0x9a8f7b, camera: 0xa34d32
};

const MATERIAL_COLORS = {
  wall: 0xe9e6dc, glass: 0x87b4bd, frame: 0x244438, oak: 0x9d6b45,
  oakDark: 0x68432d, core: 0x678c87, coreDark: 0x355e58, rust: 0xa34d32,
  rustDark: 0x71321f, cream: 0xd9d1c2, metal: 0x27352f
};

const DEFAULT_MATERIALS = {
  wall: 'wall', window: 'glass', curtainWall: 'glass', door: 'oakDark', pillar: 'coreDark', table: 'oak', lShapedOfficeDesk: 'oak',
  chair: 'cream', coffeeTable: 'cream', sofa: 'cream', backlessSofa: 'coreDark', other: 'coreDark', cube: 'core', cylinder: 'core', floor: 'cream', camera: 'rust'
};

const SECTION_HEIGHT = 1.5;
const ORTHOGONAL_SNAP_ANGLE = 10;
const CARDINAL_SIDES = ['north', 'south', 'east', 'west'];
const CARDINAL_LABELS = { north: '北', south: '南', east: '东', west: '西' };
const WALL_BOUND_KINDS = new Set(['wall', 'window', 'curtainWall', 'door']);
const HOST_WALL_KINDS = new Set(['wall', 'curtainWall']);
const COLOR_SLOT_DEFAULTS = {
  window: ['#87b4bd', '#244438', '#e9e6dc'], curtainWall: ['#87b4bd', '#244438'], door: ['#68432d', '#3f2619', '#e9e6dc'],
  lShapedOfficeDesk: ['#9d6b45', '#27352f', '#68432d', '#87b4bd', '#355e58'], chair: ['#d9d1c2', '#27352f'], sofa: ['#a34d32', '#71321f'], coffeeTable: ['#b49670', '#27352f']
};
const OPACITY_SLOT_DEFAULTS = { window: [0.48, 1, 1], curtainWall: [0.48, 1], door: [1, 1, 1], lShapedOfficeDesk: [1, 1, 1, 0.48, 1], chair: [1, 1], sofa: [1, 1], coffeeTable: [1, 1] };

const makeId = kind => `${kind}-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
const clone = value => JSON.parse(JSON.stringify(value));
const round = value => Math.round(value * 100) / 100;
const colorFor = (item, index, fallback) => item.colors?.[index] || item.color || fallback;
const opacityFor = (item, index, fallback = 1) => Math.min(1, Math.max(0, Number(item.opacities?.[index] ?? item.opacity ?? fallback)));

function normalizeLShapedOfficeDesk(item) {
  const defaults = TYPES.lShapedOfficeDesk;
  item.mainLength = Math.max(1, Number(item.mainLength ?? item.size?.[0]) || defaults.length);
  item.returnLength = Math.max(1, Number(item.returnLength ?? item.size?.[1]) || defaults.width);
  item.deskDepth = Math.max(0.45, Math.min(Number(item.deskDepth) || defaults.deskDepth, item.mainLength - 0.1, item.returnLength - 0.1));
  item.deskHeight = Math.max(0.55, Number(item.deskHeight) || defaults.deskHeight);
  item.screenHeight = Math.max(0.15, Number(item.screenHeight) || defaults.screenHeight);
  item.chairOffset = Number.isFinite(Number(item.chairOffset)) ? Number(item.chairOffset) : defaults.chairOffset;
  item.size = [item.mainLength, item.returnLength];
  item.height = item.deskHeight + 0.06 + item.screenHeight;
}

function normalizePillar(item) {
  item.pillarShape = item.pillarShape === 'round' ? 'round' : 'square';
  item.size ||= [TYPES.pillar.length, TYPES.pillar.width];
  if (item.pillarShape === 'round') {
    const diameter = Math.max(0.05, Number(item.size[0]) || Number(item.size[1]) || TYPES.pillar.length);
    item.size = [diameter, diameter];
  }
}

function normalizeRoundFurniture(item) {
  item.shape = item.shape === 'round' ? 'round' : 'rectangular';
  const defaults = TYPES[item.kind];
  item.size ||= [defaults.length, defaults.width];
  if (item.shape === 'round') {
    const diameter = Math.max(0.05, Number(item.size[0]) || Number(item.size[1]) || defaults.length);
    item.size = [diameter, diameter];
  }
}

function normalizeDoor(item) {
  item.openAngle = Math.min(180, Math.max(0, Number(item.openAngle) || 0));
}

function boundaryPosition(side, offset, model) {
  if (side === 'north') return [offset, -model.depth / 2];
  if (side === 'south') return [offset, model.depth / 2];
  if (side === 'west') return [-model.width / 2, offset];
  return [model.width / 2, offset];
}

function boundaryRotation(side) {
  return side === 'east' || side === 'west' ? Math.PI / 2 : 0;
}

function deriveItems(model) {
  const items = [];
  ['north', 'south', 'east', 'west'].forEach(side => {
    const length = side === 'north' || side === 'south' ? model.width : model.depth;
    const openings = [
      ...(model.windows || []).filter(item => item.wall === side).map(item => ({ ...item, kind: 'window' })),
      ...(model.doors || []).filter(item => item.wall === side).map(item => ({ ...item, kind: 'door' }))
    ].sort((a, b) => a.offset - b.offset);
    let cursor = -length / 2;
    const addWallSegment = (start, end) => {
      const span = end - start;
      if (span <= 0.01) return;
      items.push({ id: makeId('wall'), kind: 'wall', componentType: 'wall', material: 'wall', wallSide: side, position: boundaryPosition(side, (start + end) / 2, model), size: [span, model.wall], height: model.height, rotation: boundaryRotation(side), y: model.height / 2 });
    };
    openings.forEach(opening => {
      const start = opening.offset - opening.width / 2;
      addWallSegment(cursor, start);
      items.push({
        id: makeId(opening.kind), kind: opening.kind, componentType: opening.kind, material: DEFAULT_MATERIALS[opening.kind], sourceWall: side,
        position: boundaryPosition(side, opening.offset, model), rotation: boundaryRotation(side),
        size: [opening.width, model.wall], height: opening.kind === 'window' ? 2.18 : 2.1,
        sillHeight: opening.kind === 'window' ? Number(opening.sillHeight ?? opening.bottomWallHeight ?? 0.66) : 0, roomHeight: model.height
      });
      cursor = opening.offset + opening.width / 2;
    });
    addWallSegment(cursor, length / 2);
  });
  (model.zones || []).forEach(zone => {
    const [zx, zz] = zone.position || [0, 0];
    (zone.items || []).forEach(source => {
      const kind = source.kind === 'bench' ? 'backlessSofa' : source.kind === 'counter' || source.kind === 'island' ? 'table' : source.kind;
      if (!TYPES[kind]) return;
      const definition = TYPES[kind], [ix, iz] = source.position || [0, 0];
      items.push({ id: makeId(kind), kind, componentType: kind, material: source.material || DEFAULT_MATERIALS[kind], position: [zx + ix, zz + iz], size: clone(source.size || [definition.length, definition.width]), height: source.height || definition.height, rotation: source.rotation || 0, mirrorX: false, mirrorZ: false });
    });
  });
  return items;
}

function ensureEditorData(model) {
  if (!model.editor) model.editor = {};
  model.editor.ceilingVisible ??= false;
  const version = Number(model.editor.version) || 0;
  if (version < 2 || !Array.isArray(model.editor.items)) {
    model.editor.items = deriveItems(model);
  }
  if (version < 3) {
    const originalItems = deriveItems(model);
    model.editor.items.forEach(item => {
      if (item.material) return;
      const match = originalItems.filter(candidate => candidate.kind === item.kind).sort((a, b) => Math.hypot(a.position[0] - item.position[0], a.position[1] - item.position[1]) - Math.hypot(b.position[0] - item.position[0], b.position[1] - item.position[1]))[0];
      item.material = match?.material || DEFAULT_MATERIALS[item.kind] || 'cream';
    });
  }
  if (version < 4) {
    model.editor.items.forEach(item => {
      if (item.kind === 'chair' && Math.abs(item.height - 0.9) < 0.001) item.height = 1.19;
      if (item.kind === 'sofa' && Math.abs(item.height - 0.9) < 0.001) item.height = 1.17;
      if (item.kind === 'backlessSofa' && Math.abs(item.height - 0.48) < 0.001) item.height = 0.52;
    });
  }
  model.editor.orthogonalSnap ??= true;
  model.editor.items.forEach(item => {
    if (item.candidateComponentType === 'lShapedOfficeDesk') {
      item.kind = 'lShapedOfficeDesk';
      item.componentType = 'lShapedOfficeDesk';
    }
    item.kind ||= item.componentType;
    item.componentType ||= item.kind;
    if (item.kind === 'lShapedOfficeDesk') normalizeLShapedOfficeDesk(item);
    if (item.kind === 'door') normalizeDoor(item);
    if (item.kind === 'pillar') {
      normalizePillar(item);
      item.height = model.height;
      item.y = model.height / 2;
    }
    if (item.kind === 'coffeeTable' || item.kind === 'backlessSofa') normalizeRoundFurniture(item);
    if (item.kind === 'window') item.sillHeight = Math.max(0, Number(item.sillHeight ?? item.bottomWallHeight ?? 0.66) || 0);
    if (item.kind === 'curtainWall') {
      item.sillHeight = 0;
      item.roomHeight = model.height;
      item.height = model.height;
    }
    if (WALL_BOUND_KINDS.has(item.kind) && !item.wallSide && item.sourceWall) item.wallSide = item.sourceWall;
  });
  const walls = model.editor.items.filter(item => HOST_WALL_KINDS.has(item.kind));
  model.editor.items.filter(item => item.kind === 'door' || item.kind === 'window').forEach(opening => {
    if (opening.hostWallId && walls.some(wall => wall.id === opening.hostWallId && (opening.kind !== 'window' || wall.kind === 'wall'))) return;
    const candidates = walls.filter(wall => (opening.kind !== 'window' || wall.kind === 'wall') && (!opening.wallSide || wall.wallSide === opening.wallSide));
    const wall = candidates.sort((a, b) => {
      const distance = candidate => Math.hypot((candidate.position?.[0] || 0) - (opening.position?.[0] || 0), (candidate.position?.[1] || 0) - (opening.position?.[1] || 0));
      return distance(a) - distance(b);
    })[0];
    if (wall) { opening.hostWallId = wall.id; opening.hostWallKind = wall.kind; opening.rotation = wall.rotation || 0; opening.size[1] = wall.size?.[1] || opening.size[1]; }
  });
  let floorFound = false;
  model.editor.items = model.editor.items.filter(item => {
    if (item.kind !== 'floor') return true;
    if (floorFound) return false;
    floorFound = true;
    return true;
  });
  model.editor.version = 9;
  return model.editor;
}

export function createPlanEditor(options) {
  const { scene, renderer, controls, architecture, furniture, getCamera, getActiveModel, getModels, showTopView, syncPanel, renderScene, invalidateShadows = () => {} } = options;
  const group = new THREE.Group();
  group.name = 'plan-editor';
  group.visible = false;
  scene.add(group);

  const panel = document.querySelector('#editPanel');
  const modelPanel = document.querySelector('#modelPanel');
  const outputPanel = document.querySelector('#outputPanel');
  const overlay = document.querySelector('#outputOverlay');
  const categories = document.querySelector('#editorCategories');
  const properties = document.querySelector('#editorProperties');
  const modeLabel = document.querySelector('#editorModeLabel');
  const modeHelp = document.querySelector('#editorModeHelp');
  const importBlueprint = document.querySelector('#importBlueprint');
  const blueprintInput = document.querySelector('#blueprintFile');
  const blueprintVisible = document.querySelector('#blueprintVisible');
  const orthogonalSnap = document.querySelector('#orthogonalSnap');
  const canvas = renderer.domElement;
  const selectionBox = document.createElement('div');
  selectionBox.className = 'editor-selection-box';
  selectionBox.hidden = true;
  document.querySelector('#app').appendChild(selectionBox);
  const raycaster = new THREE.Raycaster();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), SECTION_HEIGHT);
  const pointer = new THREE.Vector2();
  const textureCache = new Map();
  const objectById = new Map();
  const sharedGeometries = new Map();
  const sharedMaterials = new Map();
  const sharedResources = new WeakSet();
  const renderSignatures = new Map();
  let renderFrame = 0;
  const defaults = Object.fromEntries(Object.entries(TYPES).filter(([, type]) => type.method !== 'asset').map(([kind, type]) => [kind, clone(type)]));
  const cameraView = options.cameraView || (() => {});
  const requestSave = options.requestSave || (() => {});
  const getPerspectiveOutlines = options.getPerspectiveOutlines || (() => true);
  function ceilingMaterial() {
    const material = new THREE.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.8, side: THREE.DoubleSide });
    material.customProgramCacheKey = () => 'ceiling-ambient-0.10';
    material.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );',
        'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor * 0.10 );'
      );
    };
    return material;
  }
  let enabled = false;
  let viewMode = 'top';
  let activeKind = '';
  let mode = 'select';
  let selectedId = '';
  let selectedIds = new Set();
  let draftStart = null;
  let draftItem = null;
  let dragging = false;
  let movingId = '';
  let quickHideMode = false;
  let quickHiddenIds = new Set();
  let dragOffset = new THREE.Vector3();
  let dragStartPosition = [0, 0];
  let dragStartPositions = new Map();
  let draggedMullion = null;
  let selectedMullion = null;
  let selectionStart = null;
  let selectionAdditive = false;

  function requestRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      renderScene();
    });
  }

  function sharedGeometry(key, factory) {
    if (!sharedGeometries.has(key)) {
      const geometry = factory();
      sharedResources.add(geometry);
      sharedGeometries.set(key, geometry);
    }
    return sharedGeometries.get(key);
  }

  function disposeObject(root) {
    root.traverse(object => {
      if (object.isInstancedMesh) object.dispose();
      if (object.geometry && !sharedResources.has(object.geometry)) object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.filter(Boolean).forEach(material => {
        if (!sharedResources.has(material)) material.dispose();
      });
    });
    root.removeFromParent();
  }

  function clearRenderedObjects() {
    [...group.children].forEach(disposeObject);
    objectById.clear();
    renderSignatures.clear();
  }

  function reconcileObject(key, signature, builder, desiredKeys) {
    desiredKeys.add(key);
    let object = group.children.find(child => child.userData.renderKey === key);
    if (object && renderSignatures.get(key) === signature) return object;
    if (object) disposeObject(object);
    object = builder();
    if (!object) {
      renderSignatures.delete(key);
      return null;
    }
    object.userData.renderKey = key;
    group.add(object);
    renderSignatures.set(key, signature);
    return object;
  }

  function currentData() { return ensureEditorData(getActiveModel()); }
  function syncHiddenIds() {
    const data = currentData();
    data.hiddenItemIds = [...quickHiddenIds];
  }
  function currentItem() { return currentData().items.find(item => item.id === selectedId); }
  function selectedItems() { return currentData().items.filter(item => selectedIds.has(item.id)); }
  function currentFloor() { return currentData().items.find(item => item.kind === 'floor'); }
  function isSelected(id) { return selectedIds.has(id); }
  function clearSelection() { selectedId = ''; selectedIds.clear(); selectedMullion = null; movingId = ''; }
  function scenePoint(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, getCamera());
    const point = new THREE.Vector3();
    return raycaster.ray.intersectPlane(floorPlane, point) ? point : null;
  }

  function updateSelectionBox(event) {
    if (!selectionStart) return;
    const left = Math.min(selectionStart.x, event.clientX);
    const top = Math.min(selectionStart.y, event.clientY);
    const crossing = event.clientX < selectionStart.x;
    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${Math.abs(event.clientX - selectionStart.x)}px`;
    selectionBox.style.height = `${Math.abs(event.clientY - selectionStart.y)}px`;
    selectionBox.classList.toggle('is-crossing', crossing);
  }

  function objectMatchesSelection(object, bounds, crossing) {
    if (!object?.visible) return false;
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return false;
    const rect = canvas.getBoundingClientRect();
    const min = box.min, max = box.max;
    const corners = [
      [min.x, min.y, min.z], [min.x, min.y, max.z], [min.x, max.y, min.z], [min.x, max.y, max.z],
      [max.x, min.y, min.z], [max.x, min.y, max.z], [max.x, max.y, min.z], [max.x, max.y, max.z]
    ];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    corners.forEach(values => {
      const point = new THREE.Vector3(...values).project(getCamera());
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const x = rect.left + (point.x + 1) * rect.width / 2;
      const y = rect.top + (1 - point.y) * rect.height / 2;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    });
    if (crossing) return left <= bounds.right && right >= bounds.left && top <= bounds.bottom && bottom >= bounds.top;
    return left >= bounds.left && right <= bounds.right && top >= bounds.top && bottom <= bounds.bottom;
  }

  function objectContainsPointer(object) {
    if (!object?.visible) return false;
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return false;
    const min = box.min, max = box.max;
    const corners = [
      [min.x, min.y, min.z], [min.x, min.y, max.z], [min.x, max.y, min.z], [min.x, max.y, max.z],
      [max.x, min.y, min.z], [max.x, min.y, max.z], [max.x, max.y, min.z], [max.x, max.y, max.z]
    ];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    corners.forEach(values => {
      const point = new THREE.Vector3(...values).project(getCamera());
      left = Math.min(left, point.x); right = Math.max(right, point.x);
      top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
    });
    const padding = 0.018;
    return pointer.x >= left - padding && pointer.x <= right + padding && pointer.y >= top - padding && pointer.y <= bottom + padding;
  }

  function finishBoxSelection(event) {
    if (!selectionStart) return;
    const bounds = {
      left: Math.min(selectionStart.x, event.clientX),
      top: Math.min(selectionStart.y, event.clientY),
      right: Math.max(selectionStart.x, event.clientX),
      bottom: Math.max(selectionStart.y, event.clientY)
    };
    const crossing = event.clientX < selectionStart.x;
    const isDrag = bounds.right - bounds.left >= 4 || bounds.bottom - bounds.top >= 4;
    const matches = isDrag
      ? currentData().items.filter(item => item.kind !== 'floor' && objectMatchesSelection(objectById.get(item.id), bounds, crossing)).map(item => item.id)
      : [];
    selectedIds = selectionAdditive ? new Set([...selectedIds, ...matches]) : new Set(matches);
    selectedId = [...selectedIds].at(-1) || '';
    activeKind = '';
    movingId = '';
    selectionStart = null;
    selectionBox.hidden = true;
    selectionBox.classList.remove('is-crossing');
    controls.enabled = true;
    updateCategoryButtons();
    showProperties();
    renderAll();
    const selectionMode = crossing ? '交叉框选' : '窗口框选';
    document.querySelector('.hint').textContent = selectedIds.size ? `${selectionMode} ${selectedIds.size} 个构件` : `${selectionMode}未选中构件`;
  }

  function snapDrawingPoint(start, point) {
    if (!start || currentData().orthogonalSnap === false) return point.clone();
    const snapped = point.clone();
    const deltaX = point.x - start.x;
    const deltaZ = point.z - start.z;
    const angle = THREE.MathUtils.radToDeg(Math.atan2(Math.abs(deltaZ), Math.abs(deltaX)));
    if (angle <= ORTHOGONAL_SNAP_ANGLE) snapped.z = start.z;
    else if (angle >= 90 - ORTHOGONAL_SNAP_ANGLE) snapped.x = start.x;
    return snapped;
  }

  function snapMovingPosition(start, position) {
    if (currentData().orthogonalSnap === false) return position;
    const snapped = [...position];
    const deltaX = position[0] - start[0];
    const deltaZ = position[1] - start[1];
    if (Math.abs(deltaX) < 0.001 && Math.abs(deltaZ) < 0.001) return snapped;
    const angle = THREE.MathUtils.radToDeg(Math.atan2(Math.abs(deltaZ), Math.abs(deltaX)));
    if (angle <= ORTHOGONAL_SNAP_ANGLE) snapped[1] = start[1];
    else if (angle >= 90 - ORTHOGONAL_SNAP_ANGLE) snapped[0] = start[0];
    return snapped;
  }

  function inferCardinalSide(item, model = getActiveModel()) {
    const [x = 0, z = 0] = item.position || [];
    const distances = {
      north: Math.abs(z + model.depth / 2),
      south: Math.abs(z - model.depth / 2),
      west: Math.abs(x + model.width / 2),
      east: Math.abs(x - model.width / 2)
    };
    return CARDINAL_SIDES.reduce((nearest, side) => distances[side] < distances[nearest] ? side : nearest, 'north');
  }

  function itemSide(item) {
    return item.wallSide || item.sourceWall || inferCardinalSide(item);
  }

  function wallFrame(wall, position) {
    const angle = wall.rotation || 0;
    const dx = position[0] - wall.position[0], dz = position[1] - wall.position[1];
    return {
      along: dx * Math.cos(angle) - dz * Math.sin(angle),
      across: dx * Math.sin(angle) + dz * Math.cos(angle)
    };
  }

  function wallPoint(wall, along) {
    const angle = wall.rotation || 0;
    return [round(wall.position[0] + along * Math.cos(angle)), round(wall.position[1] - along * Math.sin(angle))];
  }

  function curtainWallDoors(wall) {
    return currentData().items
      .filter(item => item.kind === 'door' && item.hostWallId === wall.id)
      .map(door => ({ door, along: wallFrame(wall, door.position).along }))
      .sort((a, b) => a.along - b.along);
  }

  function bestBayCount(span) {
    if (span < 1) return 1;
    const minimum = Math.max(1, Math.ceil(span / 2));
    const maximum = Math.max(minimum, Math.floor(span));
    let best = minimum;
    for (let count = minimum; count <= maximum; count += 1) {
      if (Math.abs(span / count - 1.5) < Math.abs(span / best - 1.5)) best = count;
    }
    return best;
  }

  function automaticMullionOffsets(wall) {
    const half = (wall.size?.[0] || 0) / 2;
    const offsets = [];
    const spans = [];
    let cursor = -half;
    curtainWallDoors(wall).forEach(({ door, along }) => {
      const start = along - door.size[0] / 2, end = along + door.size[0] / 2;
      if (start > cursor) spans.push([cursor, start]);
      cursor = Math.max(cursor, end);
    });
    if (cursor < half) spans.push([cursor, half]);
    spans.forEach(([start, end]) => {
      const span = end - start;
      const bays = bestBayCount(span);
      for (let bay = 1; bay < bays; bay += 1) offsets.push(round(start + span * bay / bays));
    });
    return offsets;
  }

  function curtainDoorSignature(wall) {
    return curtainWallDoors(wall)
      .map(({ door, along }) => `${door.id}:${round(along)}:${round(door.size?.[0] || 0)}`)
      .join('|');
  }

  function curtainMullionOffsets(wall) {
    if (wall.mullionMode !== 'manual') return automaticMullionOffsets(wall);
    const doorSignature = curtainDoorSignature(wall);
    if (wall.mullionDoorSignature !== doorSignature) {
      wall.mullionOffsets = automaticMullionOffsets(wall);
      wall.mullionDoorSignature = doorSignature;
    }
    const half = (wall.size?.[0] || 0) / 2;
    const doors = curtainWallDoors(wall);
    wall.mullionOffsets = (Array.isArray(wall.mullionOffsets) ? wall.mullionOffsets : automaticMullionOffsets(wall))
      .map(Number)
      .filter(offset => Number.isFinite(offset) && offset > -half + 0.08 && offset < half - 0.08)
      .filter(offset => !doors.some(({ door, along }) => Math.abs(offset - along) < door.size[0] / 2 + 0.08))
      .sort((a, b) => a - b);
    return wall.mullionOffsets;
  }

  function constrainMullionOffset(wall, mullionIndex, proposed) {
    const offsets = curtainMullionOffsets(wall);
    const half = wall.size[0] / 2, clearance = 0.12;
    const blocked = curtainWallDoors(wall).map(({ door, along }) => [along - door.size[0] / 2, along + door.size[0] / 2]);
    const boundaries = [-half, ...blocked.flat(), half].sort((a, b) => a - b);
    let interval = null;
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const origin = offsets[mullionIndex];
      if (origin >= boundaries[index] && origin <= boundaries[index + 1] && !blocked.some(([start, end]) => origin > start && origin < end)) {
        interval = [boundaries[index], boundaries[index + 1]];
        break;
      }
    }
    if (!interval) return offsets[mullionIndex];
    const previous = offsets[mullionIndex - 1], next = offsets[mullionIndex + 1];
    const minimum = Math.max(interval[0] + clearance, Number.isFinite(previous) ? previous + clearance : -Infinity);
    const maximum = Math.min(interval[1] - clearance, Number.isFinite(next) ? next - clearance : Infinity);
    return minimum <= maximum ? round(Math.max(minimum, Math.min(maximum, proposed))) : offsets[mullionIndex];
  }

  function closestWall(position, tolerance = 0.45, openingKind = '') {
    let best = null;
    currentData().items.filter(item => HOST_WALL_KINDS.has(item.kind) && (openingKind !== 'window' || item.kind === 'wall')).forEach(wall => {
      const frame = wallFrame(wall, position), half = (wall.size?.[0] || 0) / 2;
      if (Math.abs(frame.across) > tolerance || Math.abs(frame.along) > half + tolerance) return;
      const score = Math.abs(frame.across) + Math.max(0, Math.abs(frame.along) - half);
      if (!best || score < best.score) best = { wall, along: Math.max(-half, Math.min(half, frame.along)), score };
    });
    return best;
  }

  function pickHostWall(event, openingKind) {
    if (!event) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, getCamera());
    const hostHits = [];
    for (const hit of raycaster.intersectObjects(group.children, true)) {
      const id = hit.object.userData.editorId;
      const wall = currentData().items.find(item => item.id === id && HOST_WALL_KINDS.has(item.kind));
      if (wall && (openingKind !== 'window' || wall.kind === 'wall') && !hostHits.some(candidate => candidate.wall.id === wall.id)) hostHits.push({ wall, point: hit.point, distance: hit.distance });
    }
    if (!hostHits.length) return null;
    const first = hostHits[0];
    const chosen = openingKind === 'door' ? hostHits.find(candidate => candidate.wall.kind === 'curtainWall' && candidate.distance <= first.distance + 0.3) || first : first;
    return { wall: chosen.wall, along: wallFrame(chosen.wall, [chosen.point.x, chosen.point.z]).along, score: 0 };
  }

  function constrainOpeningToWall(item, position) {
    const wall = currentData().items.find(candidate => candidate.id === item.hostWallId && HOST_WALL_KINDS.has(candidate.kind));
    if (!wall) return position;
    const halfWall = (wall.size?.[0] || 0) / 2, halfOpening = (item.size?.[0] || 0) / 2;
    const limit = Math.max(0, halfWall - halfOpening);
    const along = Math.max(-limit, Math.min(limit, wallFrame(wall, position).along));
    item.rotation = wall.rotation || 0;
    item.size[1] = wall.size?.[1] || item.size[1];
    item.wallSide = wall.wallSide || wall.sourceWall;
    item.sourceWall = item.wallSide;
    return wallPoint(wall, along);
  }

  function moveHostedOpenings(wall, deltaX, deltaZ) {
    currentData().items.filter(item => item.hostWallId === wall.id).forEach(item => {
      const start = dragStartPositions.get(item.id);
      if (start) item.position = [round(start.position[0] + deltaX), round(start.position[1] + deltaZ)];
    });
  }

  function materialFor(kind, selected = false, preview = false, materialName = '', opacityValue) {
    const translucent = materialName === 'glass';
    const opacity = Math.min(1, Math.max(0, Number(opacityValue ?? (translucent ? 0.48 : 1))));
    const customColor = typeof materialName === 'string' && /^#[0-9a-f]{6}$/i.test(materialName) ? materialName : Number.isFinite(materialName) ? materialName : null;
    const color = selected ? 0xe0a23d : (customColor ?? MATERIAL_COLORS[materialName] ?? TYPE_COLORS[kind] ?? 0x678c87);
    const key = [kind, materialName, color, selected, preview, translucent, opacity].join(':');
    if (sharedMaterials.has(key)) return sharedMaterials.get(key);
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: translucent ? 0.42 : 0.72,
      transparent: preview || opacity < 1,
      opacity: preview ? Math.min(opacity, 0.58) : opacity,
      depthWrite: !preview && opacity >= 1
    });
    sharedResources.add(material);
    sharedMaterials.set(key, material);
    return material;
  }

  function edgeMaterial() {
    const key = 'editor-edges';
    if (!sharedMaterials.has(key)) {
      const material = new THREE.LineBasicMaterial({ color: 0x29332e, transparent: true, opacity: 0.72 });
      sharedResources.add(material);
      sharedMaterials.set(key, material);
    }
    return sharedMaterials.get(key);
  }

  function sectionOutlineMaterial() {
    const key = 'editor-section-edges';
    if (!sharedMaterials.has(key)) {
      const material = new THREE.LineBasicMaterial({ color: 0x29332e, transparent: true, opacity: 0.9, depthTest: false });
      sharedResources.add(material);
      sharedMaterials.set(key, material);
    }
    return sharedMaterials.get(key);
  }

  function addBox(parent, size, position, material, options = {}) {
    const geometry = sharedGeometry('box', () => new THREE.BoxGeometry(1, 1, 1));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.scale.set(...size);
    const volume = Math.abs(size[0] * size[1] * size[2]);
    mesh.castShadow = !material.transparent && volume >= 0.015 && Math.min(...size.map(Math.abs)) >= 0.035;
    mesh.receiveShadow = !material.transparent;
    parent.add(mesh);
    if (options.outline !== false && (getCamera()?.isOrthographicCamera || getPerspectiveOutlines())) {
      const edges = new THREE.LineSegments(
        sharedGeometry('box-edges', () => new THREE.EdgesGeometry(geometry)),
        edgeMaterial()
      );
      edges.raycast = () => {};
      mesh.add(edges);
    }
    return mesh;
  }

  function addInstancedBoxes(parent, boxes, material) {
    if (!boxes.length) return null;
    const mesh = new THREE.InstancedMesh(sharedGeometry('box', () => new THREE.BoxGeometry(1, 1, 1)), material, boxes.length);
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    boxes.forEach((box, index) => {
      position.fromArray(box.position);
      scale.fromArray(box.size);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = !material.transparent;
    mesh.receiveShadow = !material.transparent;
    parent.add(mesh);
    return mesh;
  }

  function addCylinder(parent, diameter, height, position, material, depth = diameter) {
    const geometry = sharedGeometry('cylinder', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 24));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.scale.set(diameter, height, depth);
    mesh.castShadow = !material.transparent && diameter * depth * height >= 0.015;
    mesh.receiveShadow = !material.transparent;
    parent.add(mesh);
    if (getCamera()?.isOrthographicCamera || getPerspectiveOutlines()) {
      const edges = new THREE.LineSegments(
        sharedGeometry('cylinder-edges', () => new THREE.EdgesGeometry(geometry, 24)),
        edgeMaterial()
      );
      edges.raycast = () => {};
      mesh.add(edges);
    }
    return mesh;
  }

  function addWallCeilingSeam(parent, center, span, width, top) {
    if (!currentData().ceilingVisible || !(getCamera()?.isOrthographicCamera || getPerspectiveOutlines())) return;
    const across = width / 2 + 0.003;
    const y = top - 0.006;
    const points = [
      new THREE.Vector3(center - span / 2, y, -across), new THREE.Vector3(center + span / 2, y, -across),
      new THREE.Vector3(center - span / 2, y, across), new THREE.Vector3(center + span / 2, y, across)
    ];
    const seam = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), edgeMaterial());
    seam.raycast = () => {};
    parent.add(seam);
  }

  function addWallElevationOutline(parent, length, width, height, centerY, openings) {
    if (getCamera()?.isOrthographicCamera || !getPerspectiveOutlines()) return;
    const points = [];
    const addRect = (left, bottom, right, top, z) => {
      points.push(
        new THREE.Vector3(left, bottom, z), new THREE.Vector3(right, bottom, z),
        new THREE.Vector3(right, bottom, z), new THREE.Vector3(right, top, z),
        new THREE.Vector3(right, top, z), new THREE.Vector3(left, top, z),
        new THREE.Vector3(left, top, z), new THREE.Vector3(left, bottom, z)
      );
    };
    const bottom = centerY - height / 2;
    const top = centerY + height / 2;
    for (const z of [-width / 2 - 0.003, width / 2 + 0.003]) {
      addRect(-length / 2, bottom, length / 2, top, z);
      openings.forEach(opening => {
        const along = wallFrame(opening.wall, opening.item.position).along;
        const half = opening.item.size[0] / 2;
        const openingBottom = opening.item.kind === 'window' ? Number(opening.item.sillHeight ?? 0.66) : 0;
        const openingTop = Math.min(top, openingBottom + Number(opening.item.height || 2.1));
        addRect(Math.max(-length / 2, along - half), openingBottom, Math.min(length / 2, along + half), openingTop, z);
      });
    }
    const outline = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), edgeMaterial());
    outline.raycast = () => {};
    parent.add(outline);
  }

  function addWallTopOutline(parent, length, width, top) {
    if (!getCamera()?.isOrthographicCamera || enabled) return;
    const y = top + 0.003;
    const halfLength = length / 2;
    const halfWidth = width / 2;
    const points = [
      new THREE.Vector3(-halfLength, y, -halfWidth), new THREE.Vector3(halfLength, y, -halfWidth),
      new THREE.Vector3(halfLength, y, -halfWidth), new THREE.Vector3(halfLength, y, halfWidth),
      new THREE.Vector3(halfLength, y, halfWidth), new THREE.Vector3(-halfLength, y, halfWidth),
      new THREE.Vector3(-halfLength, y, halfWidth), new THREE.Vector3(-halfLength, y, -halfWidth)
    ];
    const outline = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), edgeMaterial());
    outline.raycast = () => {};
    parent.add(outline);
  }

  function addWallSectionOutline(parent, center, span, width) {
    const y = SECTION_HEIGHT - 0.0005;
    const halfSpan = span / 2;
    const halfWidth = width / 2;
    const points = [
      new THREE.Vector3(center - halfSpan, y, -halfWidth),
      new THREE.Vector3(center + halfSpan, y, -halfWidth),
      new THREE.Vector3(center + halfSpan, y, halfWidth),
      new THREE.Vector3(center - halfSpan, y, halfWidth),
      new THREE.Vector3(center - halfSpan, y, -halfWidth)
    ];
    const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), sectionOutlineMaterial());
    outline.renderOrder = 20;
    outline.raycast = () => {};
    parent.add(outline);
  }

  function buildLShapedOfficeDesk(root, item, preview) {
    normalizeLShapedOfficeDesk(item);
    const selected = isSelected(item.id);
    const mainLength = item.mainLength;
    const returnLength = item.returnLength;
    const deskDepth = item.deskDepth;
    const deskHeight = item.deskHeight;
    const screenHeight = item.screenHeight;
    const topThickness = 0.08;
    const panelThickness = 0.08;
    const panelHeight = Math.max(0.3, deskHeight - topThickness);
    const mainZ = -(returnLength - deskDepth) / 2;
    const returnX = (mainLength - deskDepth) / 2;
    const oakMat = materialFor('lShapedOfficeDesk', selected, preview, colorFor(item, 0, 'oak'), opacityFor(item, 0));
    const panelMat = materialFor('lShapedOfficeDesk', selected, preview, colorFor(item, 1, 'metal'), opacityFor(item, 1));
    const cabinetMat = materialFor('lShapedOfficeDesk', selected, preview, colorFor(item, 2, 'oakDark'), opacityFor(item, 2));
    const frameMat = materialFor('lShapedOfficeDesk', selected, preview, colorFor(item, 1, 'frame'), opacityFor(item, 1));
    const glassMat = materialFor('lShapedOfficeDesk', selected, preview, colorFor(item, 3, 'glass'), opacityFor(item, 3, 0.48));
    const chairMat = materialFor('lShapedOfficeDesk', selected, preview, colorFor(item, 4, 'coreDark'), opacityFor(item, 4));

    addBox(root, [mainLength, topThickness, deskDepth], [0, deskHeight - topThickness / 2, mainZ], oakMat);
    addBox(root, [deskDepth, topThickness, returnLength], [returnX, deskHeight - topThickness / 2, 0], oakMat);

    addBox(root, [panelThickness, panelHeight, Math.max(0.2, deskDepth - panelThickness)], [-mainLength / 2 + panelThickness / 2, panelHeight / 2, mainZ], panelMat);
    addBox(root, [Math.max(0.2, deskDepth - panelThickness), panelHeight, panelThickness], [returnX, panelHeight / 2, returnLength / 2 - panelThickness / 2], panelMat);
    addBox(root, [Math.max(0.2, mainLength - panelThickness * 2), panelHeight, panelThickness], [0, panelHeight / 2, -returnLength / 2 + panelThickness / 2], panelMat);
    addBox(root, [panelThickness, panelHeight, Math.max(0.2, returnLength - panelThickness * 2)], [mainLength / 2 - panelThickness / 2, panelHeight / 2, 0], panelMat);

    const pedestalWidth = Math.max(0.28, Math.min(0.54, deskDepth - 0.12));
    const pedestalDepth = Math.max(0.32, Math.min(0.58, returnLength * 0.38));
    const pedestalHeight = Math.max(0.35, Math.min(0.68, panelHeight - 0.02));
    const pedestalX = mainLength / 2 - pedestalWidth / 2 - 0.05;
    const pedestalZ = returnLength / 2 - pedestalDepth / 2 - 0.19;
    addBox(root, [pedestalWidth, pedestalHeight, pedestalDepth], [pedestalX, pedestalHeight / 2, pedestalZ], cabinetMat);
    const handleZ = pedestalZ + pedestalDepth / 2 + 0.011;
    addInstancedBoxes(root, [0.78, 0.47, 0.16].map(ratio => ({ size: [Math.max(0.18, pedestalWidth - 0.1), 0.04, 0.02], position: [pedestalX, pedestalHeight * ratio, handleZ] })), panelMat);

    const frameThickness = 0.055;
    const frameDepth = 0.065;
    const glassHeight = Math.max(0.05, screenHeight - frameThickness * 2);
    const screenBottom = deskHeight + 0.06;
    const screenCenter = screenBottom + screenHeight / 2;
    const mainScreenZ = -returnLength / 2 + frameDepth / 2;
    const returnScreenX = mainLength / 2 - frameDepth / 2;
    addBox(root, [Math.max(0.1, mainLength - frameThickness * 2), glassHeight, 0.035], [0, screenCenter, mainScreenZ], glassMat);
    addBox(root, [mainLength, frameThickness, frameDepth], [0, screenBottom + frameThickness / 2, mainScreenZ], frameMat);
    addBox(root, [mainLength, frameThickness, frameDepth], [0, screenBottom + screenHeight - frameThickness / 2, mainScreenZ], frameMat);
    addBox(root, [frameThickness, screenHeight, frameDepth], [-mainLength / 2 + frameThickness / 2, screenCenter, mainScreenZ], frameMat);
    addBox(root, [frameThickness, screenHeight, frameDepth], [mainLength / 2 - frameThickness / 2, screenCenter, mainScreenZ], frameMat);
    addBox(root, [0.035, glassHeight, Math.max(0.1, returnLength - frameThickness * 2)], [returnScreenX, screenCenter, 0], glassMat);
    addBox(root, [frameDepth, frameThickness, returnLength], [returnScreenX, screenBottom + frameThickness / 2, 0], frameMat);
    addBox(root, [frameDepth, frameThickness, returnLength], [returnScreenX, screenBottom + screenHeight - frameThickness / 2, 0], frameMat);
    addBox(root, [frameDepth, screenHeight, frameThickness], [returnScreenX, screenCenter, returnLength / 2 - frameThickness / 2], frameMat);

    const chairX = -0.25 * mainLength / 2.4;
    const chairZ = item.chairOffset;
    addBox(root, [0.56, 0.12, 0.52], [chairX, 0.49, chairZ], chairMat);
    addBox(root, [0.56, 0.48, 0.1], [chairX, 0.76, chairZ + 0.24], chairMat);
    addBox(root, [0.1, 0.38, 0.1], [chairX, 0.27, chairZ], panelMat);
    addBox(root, [0.62, 0.06, 0.08], [chairX, 0.09, chairZ], panelMat);
    addBox(root, [0.08, 0.06, 0.62], [chairX, 0.09, chairZ], panelMat);
    addInstancedBoxes(root, [[chairX - 0.3, chairZ], [chairX + 0.3, chairZ], [chairX, chairZ - 0.3], [chairX, chairZ + 0.3]].map(([x, z]) => ({ size: [0.1, 0.09, 0.1], position: [x, 0.045, z] })), panelMat);
  }


  function polygonArea(points) {
    return points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point[0] * next[1] - next[0] * point[1]; }, 0) / 2;
  }

  function offsetPolygon(points, distance) {
    if (points.length < 3) return points;
    const ccw = polygonArea(points) > 0;
    const lines = points.map((point, index) => {
      const previous = points[(index - 1 + points.length) % points.length];
      const next = points[(index + 1) % points.length];
      const edgeX = next[0] - point[0], edgeZ = next[1] - point[1], edgeLength = Math.hypot(edgeX, edgeZ) || 1;
      const normal = ccw ? [edgeZ / edgeLength, -edgeX / edgeLength] : [-edgeZ / edgeLength, edgeX / edgeLength];
      return { point: [point[0] + normal[0] * distance, point[1] + normal[1] * distance], direction: [edgeX, edgeZ] };
    });
    return points.map((_, index) => {
      const first = lines[(index - 1 + lines.length) % lines.length], second = lines[index];
      const cross = first.direction[0] * second.direction[1] - first.direction[1] * second.direction[0];
      if (Math.abs(cross) < 0.0001) return second.point;
      const deltaX = second.point[0] - first.point[0], deltaZ = second.point[1] - first.point[1];
      const t = (deltaX * second.direction[1] - deltaZ * second.direction[0]) / cross;
      return [first.point[0] + first.direction[0] * t, first.point[1] + first.direction[1] * t];
    });
  }

  function polygonCenter(points) {
    const sum = points.reduce((result, point) => [result[0] + point[0], result[1] + point[1]], [0, 0]);
    return [sum[0] / points.length, sum[1] / points.length];
  }

  function buildPolygonShape(points, offset = 0) {
    const expanded = offsetPolygon(points, offset);
    const shape = new THREE.Shape();
    expanded.forEach((point, index) => index === 0 ? shape.moveTo(point[0], -point[1]) : shape.lineTo(point[0], -point[1]));
    shape.closePath();
    return { shape, expanded };
  }

  function buildItem(item, preview = false) {
    const kind = item.componentType || item.kind;
    const root = new THREE.Group();
    root.userData.editorId = item.id;
    root.position.set(item.position[0], item.elevation || 0, item.position[1]);
    root.rotation.y = item.rotation || 0;
    root.scale.set(item.mirrorX ? -1 : 1, 1, item.mirrorZ ? -1 : 1);
    const [length = 0, width = 0] = item.size || [];
    const height = item.height || TYPES[kind]?.height || 0.5;
    const mat = materialFor(kind, isSelected(item.id), preview, item.color || item.material || DEFAULT_MATERIALS[kind], opacityFor(item, 0));
    if (kind === 'floor') {
      const points = Array.isArray(item.points) ? item.points : [];
      const displayPoints = item.previewPoint ? [...points, item.previewPoint] : points;
      if (points.length >= 3) {
        const { shape, expanded } = buildPolygonShape(points, Number(item.offset) || 0);
        const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: item.height || 0.1, bevelEnabled: false }), mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = -(item.height || 0.1);
        mesh.receiveShadow = true;
        root.add(mesh);
        const expandedOutline = expanded.map(point => new THREE.Vector3(point[0], 0.014, point[1]));
        expandedOutline.push(expandedOutline[0].clone());
        root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(expandedOutline), new THREE.LineBasicMaterial({ color: isSelected(item.id) ? 0xe0a23d : 0x6f6659, transparent: true, opacity: preview ? 0.65 : 0.72 })));
      }
      if (displayPoints.length >= 2) {
        const draftLine = displayPoints.map(point => new THREE.Vector3(point[0], 0.03, point[1]));
        root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(draftLine), new THREE.LineBasicMaterial({ color: 0xa34d32, transparent: true, opacity: 0.9 })));
      }
    } else if (kind === 'camera') {
      if (!enabled) return root;
      const cameraHeight = Number(item.cameraHeight) || 1.65;
      const target = item.target || [item.position[0], item.position[1] - 1];
      const directionX = target[0] - item.position[0], directionZ = target[1] - item.position[1];
      const angle = Math.atan2(-directionZ, directionX);
      const marker = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.2, 4), mat);
      marker.position.y = 0.2;
      marker.rotation.z = -Math.PI / 2;
      marker.rotation.y = angle;
      root.add(marker);
      const endpoint = new THREE.Vector3(directionX, cameraHeight, directionZ);
      root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, cameraHeight, 0), endpoint]), new THREE.LineBasicMaterial({ color: isSelected(item.id) ? 0xe0a23d : 0xa34d32, transparent: true, opacity: preview ? 0.75 : 0.9 })));
      const left = new THREE.Vector3(directionX * 0.82 + directionZ * 0.16, cameraHeight, directionZ * 0.82 - directionX * 0.16);
      const right = new THREE.Vector3(directionX * 0.82 - directionZ * 0.16, cameraHeight, directionZ * 0.82 + directionX * 0.16);
      root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([endpoint, left, right, endpoint]), new THREE.LineBasicMaterial({ color: isSelected(item.id) ? 0xe0a23d : 0xa34d32, transparent: true, opacity: preview ? 0.65 : 0.8 })));
    } else if (kind === 'wall') {
      const hostedOpenings = currentData().items.filter(candidate => ['door', 'window'].includes(candidate.kind) && candidate.hostWallId === item.id);
      const openings = hostedOpenings.map(opening => {
        const along = wallFrame(item, opening.position).along, half = opening.size[0] / 2;
        return [Math.max(-length / 2, along - half), Math.min(length / 2, along + half)];
      }).sort((a, b) => a[0] - b[0]);
      const merged = [];
      openings.forEach(interval => { const last = merged.at(-1); if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]); else merged.push([...interval]); });
      let cursor = -length / 2;
      [...merged, [length / 2, length / 2]].forEach(interval => {
        const span = interval[0] - cursor;
        if (span > 0.01) {
          const center = cursor + span / 2;
          const centerY = item.y ?? height / 2;
          addBox(root, [span, height, width], [center, centerY, 0], mat, { outline: false });
          if (Math.abs(centerY + height / 2 - getActiveModel().height) < 0.01) addWallCeilingSeam(root, center, span, width, centerY + height / 2);
          if (enabled && viewMode === 'top' && centerY - height / 2 < SECTION_HEIGHT && centerY + height / 2 > SECTION_HEIGHT) {
            addBox(root, [span, 0.018, width], [center, SECTION_HEIGHT - 0.01, 0], mat, { outline: false });
            addWallSectionOutline(root, center, span, width);
          }
        }
        cursor = Math.max(cursor, interval[1]);
      });
      addWallElevationOutline(root, length, width, height, item.y ?? height / 2, hostedOpenings.map(opening => ({ wall: item, item: opening })));
      addWallTopOutline(root, length, width, (item.y ?? height / 2) + height / 2);
    } else if (kind === 'pillar') {
      normalizePillar(item);
      const centerY = item.y ?? height / 2;
      if (item.pillarShape === 'round') {
        addCylinder(root, item.size[0], height, [0, centerY, 0], mat);
        if (enabled && viewMode === 'top' && centerY - height / 2 < SECTION_HEIGHT && centerY + height / 2 > SECTION_HEIGHT) addCylinder(root, item.size[0], 0.018, [0, SECTION_HEIGHT - 0.01, 0], mat);
      } else {
        addBox(root, [length, height, width], [0, centerY, 0], mat);
        if (enabled && viewMode === 'top' && centerY - height / 2 < SECTION_HEIGHT && centerY + height / 2 > SECTION_HEIGHT) addBox(root, [length, 0.018, width], [0, SECTION_HEIGHT - 0.01, 0], mat);
      }
    }
    else if (kind === 'window' || kind === 'curtainWall') {
      const selected = isSelected(item.id);
      const curtainWall = kind === 'curtainWall';
      const sillHeight = curtainWall ? 0 : item.sillHeight ?? 0.66;
      const roomHeight = curtainWall ? getActiveModel().height : item.roomHeight || getActiveModel().height;
      const openingHeight = curtainWall ? roomHeight : height;
      const headerHeight = curtainWall ? 0 : Math.max(0, roomHeight - sillHeight - openingHeight);
      const wallMat = materialFor('wall', selected, preview, colorFor(item, 2, 'wall'), opacityFor(item, 2));
      const frameMat = materialFor(kind, selected, preview, colorFor(item, 1, 'frame'), opacityFor(item, 1));
      const selectedMullionMat = materialFor('curtainWallMullion', false, preview, '#c2472f', 1);
      const glassMat = materialFor(kind, selected, preview, colorFor(item, 0, 'glass'), opacityFor(item, 0, 0.48));
      const mullionOffsets = curtainWall ? curtainMullionOffsets(item) : [0];
      if (curtainWall) {
        const doors = currentData().items.filter(candidate => candidate.kind === 'door' && candidate.hostWallId === item.id).map(door => ({ door, along: wallFrame(item, door.position).along })).sort((a, b) => a.along - b.along);
        if (doors.length) {
          let cursor = -length / 2;
          [...doors.map(({ door, along }) => [along - door.size[0] / 2, along + door.size[0] / 2, door]), [length / 2, length / 2, null]].forEach(([start, end, door]) => {
            const span = start - cursor;
            if (span > 0.01) {
              const center = cursor + span / 2;
              addBox(root, [Math.max(0.05, span - 0.04), Math.max(0.05, roomHeight - 0.08), Math.min(0.06, width)], [center, roomHeight / 2, 0], glassMat);
            }
            if (door) {
              const headerHeight = Math.max(0, roomHeight - door.height);
              const doorHeaderMat = materialFor('door', selected || isSelected(door.id), preview, colorFor(door, 0, door.material || 'oakDark'), 1);
              if (headerHeight > 0.08) addBox(root, [door.size[0], headerHeight - 0.08, width], [(start + end) / 2, door.height + (headerHeight - 0.08) / 2, 0], doorHeaderMat);
              addBox(root, [0.065, roomHeight, Math.max(0.12, width)], [start - 0.0325, roomHeight / 2, 0], frameMat);
              addBox(root, [0.065, roomHeight, Math.max(0.12, width)], [end + 0.0325, roomHeight / 2, 0], frameMat);
            }
            cursor = end;
          });
          mullionOffsets.forEach((offset, mullionIndex) => {
            const mullionMat = selectedMullion?.wallId === item.id && selectedMullion.index === mullionIndex ? selectedMullionMat : frameMat;
            const intersectingDoor = doors.find(({ door, along }) => {
              const halfDoor = door.size[0] / 2;
              return offset > along - halfDoor - 0.04 && offset < along + halfDoor + 0.04;
            })?.door;
            if (!intersectingDoor) {
              const mullion = addBox(root, [0.065, roomHeight, Math.max(0.12, width)], [offset, roomHeight / 2, 0], mullionMat);
              mullion.userData.mullionIndex = mullionIndex;
              return;
            }
            const upperHeight = Math.max(0, roomHeight - intersectingDoor.height);
            if (upperHeight > 0.01) {
              const mullion = addBox(root, [0.065, upperHeight, Math.max(0.12, width)], [offset, intersectingDoor.height + upperHeight / 2, 0], mullionMat);
              mullion.userData.mullionIndex = mullionIndex;
            }
          });
          addBox(root, [0.08, roomHeight, Math.max(0.12, width)], [-length / 2 + 0.04, roomHeight / 2, 0], frameMat);
          addBox(root, [0.08, roomHeight, Math.max(0.12, width)], [length / 2 - 0.04, roomHeight / 2, 0], frameMat);
          addBox(root, [length, 0.08, Math.max(0.12, width)], [0, 0.04, 0], frameMat);
          addBox(root, [length, 0.08, Math.max(0.12, width)], [0, roomHeight - 0.04, 0], frameMat);
          root.traverse(object => { object.userData.editorId = item.id; });
          return root;
        }
      }
      if (sillHeight > 0) addBox(root, [length, sillHeight, width], [0, sillHeight / 2, 0], wallMat, { outline: false });
      if (headerHeight > 0) addBox(root, [length, headerHeight, width], [0, sillHeight + height + headerHeight / 2, 0], wallMat, { outline: false });
      addBox(root, [Math.max(0.05, length - 0.08), Math.max(0.05, openingHeight - 0.08), Math.min(0.06, width)], [0, sillHeight + openingHeight / 2, 0], glassMat);
      addBox(root, [length, 0.08, Math.max(0.12, width)], [0, sillHeight + 0.04, 0], frameMat);
      addBox(root, [length, 0.08, Math.max(0.12, width)], [0, sillHeight + openingHeight - 0.04, 0], frameMat);
      addBox(root, [0.08, openingHeight, Math.max(0.12, width)], [-length / 2 + 0.04, sillHeight + openingHeight / 2, 0], frameMat);
      addBox(root, [0.08, openingHeight, Math.max(0.12, width)], [length / 2 - 0.04, sillHeight + openingHeight / 2, 0], frameMat);
      mullionOffsets.forEach((offset, mullionIndex) => {
        const mullionMat = selectedMullion?.wallId === item.id && selectedMullion.index === mullionIndex ? selectedMullionMat : frameMat;
        const mullion = addBox(root, [0.065, openingHeight, Math.max(0.12, width)], [offset, sillHeight + openingHeight / 2, 0], mullionMat);
        if (curtainWall) mullion.userData.mullionIndex = mullionIndex;
      });
      if (enabled && viewMode === 'top' && SECTION_HEIGHT > sillHeight && SECTION_HEIGHT < sillHeight + openingHeight) {
        addBox(root, [length, 0.018, Math.min(0.05, width)], [0, SECTION_HEIGHT - 0.01, 0], glassMat);
        addBox(root, [0.08, 0.02, Math.max(0.12, width)], [-length / 2 + 0.04, SECTION_HEIGHT - 0.01, 0], frameMat);
        addBox(root, [0.08, 0.02, Math.max(0.12, width)], [length / 2 - 0.04, SECTION_HEIGHT - 0.01, 0], frameMat);
        mullionOffsets.forEach(offset => addBox(root, [0.065, 0.02, Math.max(0.12, width)], [offset, SECTION_HEIGHT - 0.01, 0], frameMat));
      }
    }
    else if (kind === 'door') {
      normalizeDoor(item);
      const selected = isSelected(item.id);
      const roomHeight = item.roomHeight || getActiveModel().height;
      const host = currentData().items.find(candidate => candidate.id === item.hostWallId);
      const curtainWallDoor = host?.kind === 'curtainWall' || item.hostWallKind === 'curtainWall';
      const headerHeight = curtainWallDoor ? 0 : Math.max(0, roomHeight - height);
      const wallMat = materialFor('wall', selected, preview, colorFor(item, 2, 'wall'), opacityFor(item, 2));
      const leafMat = materialFor(kind, selected, preview, colorFor(item, 0, item.material || 'oakDark'), opacityFor(item, 0));
      const frameMat = materialFor(kind, selected, preview, colorFor(item, 1, '#3f2619'), opacityFor(item, 1));
      if (!curtainWallDoor && headerHeight > 0) addBox(root, [length, headerHeight, width], [0, height + headerHeight / 2, 0], wallMat, { outline: false });
      addBox(root, [0.08, height, Math.max(0.12, width)], [-length / 2 + 0.04, height / 2, 0], frameMat);
      addBox(root, [0.08, height, Math.max(0.12, width)], [length / 2 - 0.04, height / 2, 0], frameMat);
      addBox(root, [length, 0.08, Math.max(0.12, width)], [0, height - 0.04, 0], frameMat);
      const leaf = new THREE.Group();
      leaf.position.x = -length / 2 + 0.04;
      leaf.rotation.y = THREE.MathUtils.degToRad(item.openAngle);
      addBox(leaf, [length - 0.08, height - 0.08, 0.08], [(length - 0.08) / 2, height / 2, 0], leafMat);
      root.add(leaf);
      if (enabled && viewMode === 'top' && SECTION_HEIGHT < height) {
        addBox(root, [0.08, 0.02, Math.max(0.12, width)], [-length / 2 + 0.04, SECTION_HEIGHT - 0.01, 0], frameMat);
        addBox(root, [0.08, 0.02, Math.max(0.12, width)], [length / 2 - 0.04, SECTION_HEIGHT - 0.01, 0], frameMat);
        const leafSection = new THREE.Group();
        leafSection.position.x = -length / 2 + 0.04;
        leafSection.rotation.y = THREE.MathUtils.degToRad(item.openAngle);
        addBox(leafSection, [length - 0.08, 0.02, 0.08], [(length - 0.08) / 2, SECTION_HEIGHT - 0.01, 0], leafMat);
        root.add(leafSection);
      }
    } else if (kind === 'lShapedOfficeDesk') {
      buildLShapedOfficeDesk(root, item, preview);
    } else if (kind === 'chair') {
      const legMat = materialFor('chair', isSelected(item.id), preview, colorFor(item, 1, 'metal'), opacityFor(item, 1));
      const scaleY = height / 1.19;
      addBox(root, [length, 0.14 * scaleY, width], [0, 0.52 * scaleY, 0], mat);
      addBox(root, [length, 0.72 * scaleY, 0.13], [0, 0.83 * scaleY, width / 2 - 0.065], mat);
      const legX = Math.max(0.12, length / 2 - 0.1), legZ = Math.max(0.12, width / 2 - 0.1);
      addInstancedBoxes(root, [-legX, legX].flatMap(x => [-legZ, legZ].map(z => ({ size: [0.08, 0.5 * scaleY, 0.08], position: [x, 0.25 * scaleY, z] }))), legMat);
    } else if (kind === 'sofa') {
      const structureMat = materialFor('sofa', isSelected(item.id), preview, colorFor(item, 1, 'rustDark'), opacityFor(item, 1));
      const scaleY = height / 1.17;
      addBox(root, [length, 0.36 * scaleY, width], [0, 0.28 * scaleY, 0], structureMat);
      addBox(root, [Math.max(0.1, length - 0.08), 0.22 * scaleY, Math.max(0.1, width - 0.22)], [0, 0.56 * scaleY, -0.07], mat);
      addBox(root, [length, 0.82 * scaleY, 0.2], [0, 0.76 * scaleY, width / 2 - 0.1], mat);
      addBox(root, [0.16, 0.62 * scaleY, width], [-length / 2 + 0.08, 0.55 * scaleY, 0], structureMat);
      addBox(root, [0.16, 0.62 * scaleY, width], [length / 2 - 0.08, 0.55 * scaleY, 0], structureMat);
    } else if (kind === 'coffeeTable') {
      normalizeRoundFurniture(item);
      const legMat = materialFor(kind, isSelected(item.id), preview, colorFor(item, 1, 'metal'), opacityFor(item, 1));
      if (item.shape === 'round') {
        addCylinder(root, item.size[0], 0.12, [0, height, 0], mat);
        addCylinder(root, Math.max(0.12, item.size[0] * 0.34), height, [0, height / 2, 0], legMat);
      } else {
        addBox(root, [length, 0.12, width], [0, height, 0], mat);
        const px = Math.max(0.16, length / 2 - 0.18), pz = Math.max(0.16, width / 2 - 0.18);
        addInstancedBoxes(root, [-px, px].flatMap(x => [-pz, pz].map(z => ({ size: [0.09, height, 0.09], position: [x, height / 2, z] }))), legMat);
      }
    } else if (kind === 'backlessSofa') {
      normalizeRoundFurniture(item);
      const scaleY = height / 0.52;
      if (item.shape === 'round') addCylinder(root, item.size[0], 0.46 * scaleY, [0, 0.29 * scaleY, 0], mat);
      else addBox(root, [length, 0.46 * scaleY, width], [0, 0.29 * scaleY, 0], mat);
    } else if (kind === 'cube') {
      addBox(root, [length, height, width], [0, height / 2, 0], mat);
    } else if (kind === 'cylinder') {
      addCylinder(root, Math.max(0.05, length), height, [0, height / 2, 0], mat, Math.max(0.05, width));
    } else if (kind === 'other') {
      if (Array.isArray(item.parts) && item.parts.length) {
        item.parts.forEach(part => {
          if (!Array.isArray(part.size) || part.size.length !== 3) return;
          const partRoot = new THREE.Group();
          partRoot.position.set(...(part.position || [0, part.size[1] / 2, 0]));
          partRoot.rotation.set(...(part.rotation || [0, 0, 0]));
          const partMaterial = part.color || part.material || item.color || item.material || DEFAULT_MATERIALS[kind];
          if (part.shape === 'cylinder') addCylinder(partRoot, Math.max(0.05, part.size[0]), part.size[1], [0, 0, 0], materialFor(kind, isSelected(item.id), preview, partMaterial, part.opacity ?? 1), Math.max(0.05, part.size[2] || part.size[0]));
          else addBox(partRoot, part.size, [0, 0, 0], materialFor(kind, isSelected(item.id), preview, partMaterial, part.opacity ?? 1));
          root.add(partRoot);
        });
      } else {
        addBox(root, [length, height, width], [0, height / 2, 0], mat);
      }
    } else {
      const legMat = materialFor(kind, isSelected(item.id), preview, 'metal');
      addBox(root, [length, 0.12, width], [0, height, 0], mat);
      const px = Math.max(0.16, length / 2 - 0.18), pz = Math.max(0.16, width / 2 - 0.18);
      addInstancedBoxes(root, [-px, px].flatMap(x => [-pz, pz].map(z => ({ size: [0.09, height, 0.09], position: [x, height / 2, z] }))), legMat);
    }
    root.traverse(object => { object.userData.editorId = item.id; });
    return root;
  }

  function buildBackground(background) {
    if (!background?.dataUrl || background.visible === false) return null;
    let texture = textureCache.get(background.dataUrl);
    if (!texture) {
      texture = new THREE.TextureLoader().load(background.dataUrl, () => renderScene());
      texture.colorSpace = THREE.SRGBColorSpace;
      textureCache.set(background.dataUrl, texture);
    }
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: background.opacity ?? 0.45, side: THREE.DoubleSide, depthWrite: false, color: isSelected('background') ? 0xffd98b : 0xffffff });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(background.width, background.depth), material);
    mesh.name = 'blueprint-background';
    mesh.userData.editorId = 'background';
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = -(background.rotation || 0);
    mesh.position.set(background.position?.[0] || 0, 0.035, background.position?.[1] || 0);
    return mesh;
  }

  function buildCeilingForFloor(floor, model) {
    if (!Array.isArray(floor.points) || floor.points.length < 3 || quickHiddenIds.has(`ceiling-${floor.id}`)) return null;
    const { shape } = buildPolygonShape(floor.points, Number(floor.offset) || 0);
    const thickness = 0.12;
    const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false }), ceilingMaterial());
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(floor.position[0], model.height, floor.position[1]);
    mesh.userData.editorId = `ceiling-${floor.id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  function renderAll() {
    const model = getActiveModel();
    if (!model) return;
    const hasEditorData = Array.isArray(model.editor?.items);
    if (!enabled && !hasEditorData) {
      group.visible = false;
      renderScene();
      return;
    }
    group.visible = true;
    const data = currentData();
    const desiredKeys = new Set();
    if (!data.emptySpace || !data.items.some(item => item.kind === 'floor')) {
      reconcileObject('default-floor', `${model.width}:${model.depth}`, () => {
        const floor = new THREE.Mesh(sharedGeometry('box', () => new THREE.BoxGeometry(1, 1, 1)), materialFor('floor', false, false, 'cream'));
        floor.scale.set(model.width + 0.44, 0.1, model.depth + 0.44);
        floor.position.y = -0.05;
        floor.receiveShadow = true;
        return floor;
      }, desiredKeys);
    }
    if (data.background?.dataUrl && data.background.visible !== false) {
      reconcileObject('background', JSON.stringify(data.background) + ':' + isSelected('background'), () => buildBackground(data.background), desiredKeys);
    }
    data.items.forEach(item => {
      if (quickHiddenIds.has(item.id)) return;
      if (WALL_BOUND_KINDS.has(item.kind)) {
        const side = item.wallSide || item.sourceWall;
        if (side && data.wallVisibility?.[side] === false) return;
      }
      const key = `item:${item.id}`;
      const hostedOpenings = HOST_WALL_KINDS.has(item.kind) ? data.items.filter(candidate => candidate.hostWallId === item.id).map(candidate => [candidate.id, candidate.kind, candidate.position, candidate.size, candidate.height]) : [];
      const mullionSelection = selectedMullion?.wallId === item.id ? selectedMullion.index : '';
      const signature = JSON.stringify(item) + JSON.stringify(hostedOpenings) + `:${isSelected(item.id)}:${mullionSelection}:${enabled}:${viewMode}`;
      const object = reconcileObject(key, signature, () => buildItem(item), desiredKeys);
      objectById.set(item.id, object);
    });
    if (data.ceilingVisible) {
      const floors = data.items.filter(item => item.kind === 'floor');
      if (floors.length) floors.forEach(floor => reconcileObject(`ceiling:${floor.id}`, JSON.stringify(floor) + `:${model.height}`, () => buildCeilingForFloor(floor, model), desiredKeys));
      else {
        reconcileObject('ceiling-default', `${model.width}:${model.depth}:${model.height}`, () => {
          const ceiling = new THREE.Mesh(sharedGeometry('box', () => new THREE.BoxGeometry(1, 1, 1)), ceilingMaterial());
          ceiling.scale.set(model.width + 0.44, 0.12, model.depth + 0.44);
          ceiling.position.y = model.height + 0.06;
          ceiling.userData.editorId = 'ceiling-default';
          ceiling.castShadow = true;
          ceiling.receiveShadow = true;
          return ceiling;
        }, desiredKeys);
      }
    }
    if (draftItem) reconcileObject('draft', JSON.stringify(draftItem) + `:${enabled}:${viewMode}`, () => buildItem(draftItem, true), desiredKeys);
    [...group.children].forEach(object => {
      const key = object.userData.renderKey;
      if (key && !desiredKeys.has(key)) {
        if (key.startsWith('item:')) objectById.delete(key.slice(5));
        renderSignatures.delete(key);
        disposeObject(object);
      }
    });
    invalidateShadows();
    renderScene();
  }

  function syncItemTransform(item) {
    const object = objectById.get(item.id);
    if (!object) return;
    object.position.set(item.position[0], 0, item.position[1]);
    object.rotation.y = item.rotation || 0;
    object.scale.set(item.mirrorX ? -1 : 1, 1, item.mirrorZ ? -1 : 1);
    object.updateMatrixWorld();
    renderSignatures.set(`item:${item.id}`, JSON.stringify(item) + `:${isSelected(item.id)}:${enabled}:${viewMode}`);
  }

  function refreshRenderedItem(item) {
    const key = `item:${item.id}`;
    const object = group.children.find(child => child.userData.renderKey === key);
    if (object) disposeObject(object);
    const replacement = buildItem(item);
    replacement.userData.renderKey = key;
    group.add(replacement);
    objectById.set(item.id, replacement);
    renderSignatures.set(key, JSON.stringify(item) + `:${isSelected(item.id)}:${enabled}:${viewMode}`);
  }

  function field(label, value, onInput, options = {}) {
    const wrapper = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.value = Number.isFinite(Number(value)) ? String(round(value)) : '';
    if (options.placeholder) input.placeholder = options.placeholder;
    input.disabled = Boolean(options.disabled);
    input.step = String(options.step ?? 0.05);
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    const unit = document.createElement('output');
    unit.textContent = options.unit || 'm';
    input.addEventListener('input', () => {
      const number = Number(input.value);
      if (Number.isFinite(number)) onInput(number);
    });
    wrapper.append(name, input, unit);
    properties.appendChild(wrapper);
  }

  function batchField(label, items, getter, setter, options = {}) {
    const values = items.map(getter);
    const first = Number(values[0]);
    const same = values.every(value => Math.abs(Number(value) - first) < 0.0001);
    field(label, same ? first : NaN, value => {
      items.forEach(item => setter(item, value));
      renderAll();
    }, { ...options, placeholder: same ? '' : '多值' });
  }

  function selectField(label, value, onInput, mixed = false, choices = CARDINAL_SIDES.map(side => [side, CARDINAL_LABELS[side]])) {
    const wrapper = document.createElement('label');
    wrapper.className = 'editor-select-field';
    const name = document.createElement('span'); name.textContent = label;
    const input = document.createElement('select');
    if (mixed) { const option = document.createElement('option'); option.value = ''; option.textContent = '多值'; input.appendChild(option); }
    choices.forEach(([choiceValue, choiceLabel]) => { const option = document.createElement('option'); option.value = choiceValue; option.textContent = choiceLabel; input.appendChild(option); });
    input.value = value;
    input.addEventListener('change', () => onInput(input.value));
    const unit = document.createElement('output'); unit.textContent = '';
    wrapper.append(name, input, unit); properties.appendChild(wrapper);
  }

  function colorOpacityField(label, colorValue, opacityValue, onColorInput, onOpacityInput) {
    const wrapper = document.createElement('label');
    wrapper.className = 'editor-color-opacity';
    const name = document.createElement('span'); name.textContent = label;
    const controls = document.createElement('span'); controls.className = 'editor-color-opacity-controls';
    const colorInput = document.createElement('input'); colorInput.type = 'color'; colorInput.value = /^#[0-9a-f]{6}$/i.test(colorValue || '') ? colorValue : '#678c87';
    const opacityInput = document.createElement('input'); opacityInput.type = 'number'; opacityInput.min = '0'; opacityInput.max = '1'; opacityInput.step = '0.05'; opacityInput.value = String(round(opacityValue)); opacityInput.title = '透明度'; opacityInput.setAttribute('aria-label', `${label}透明度`);
    colorInput.addEventListener('input', () => onColorInput(colorInput.value));
    opacityInput.addEventListener('input', () => { const value = Number(opacityInput.value); if (Number.isFinite(value)) onOpacityInput(Math.min(1, Math.max(0, value))); });
    controls.append(colorInput, opacityInput);
    wrapper.append(name, controls); properties.appendChild(wrapper);
  }

  function itemColorFields(item) {
    const defaults = COLOR_SLOT_DEFAULTS[item.kind];
    if (!defaults) {
      colorOpacityField('颜色', item.color, opacityFor(item, 0), value => { item.color = value; renderAll(); }, value => { item.opacity = value; renderAll(); });
      return;
    }
    item.colors ||= [...defaults];
    item.opacities ||= [...(OPACITY_SLOT_DEFAULTS[item.kind] || defaults.map(() => 1))];
    item.colors.forEach((color, index) => {
      colorOpacityField(`颜色 ${index + 1}`, color, opacityFor(item, index), value => { item.colors[index] = value; renderAll(); }, value => { item.opacities[index] = value; renderAll(); });
    });
  }

  function transformButtons(items) {
    items = Array.isArray(items) ? items : [items];
    const row = document.createElement('div');
    row.className = 'editor-transform';
    [['沿 X 镜像', 'mirrorX'], ['沿 Z 镜像', 'mirrorZ'], ['复制', 'copy'], ['移动', 'move']].forEach(([label, action]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (action === 'move') {
        button.setAttribute('aria-pressed', String(movingId === 'selection'));
        button.title = '启用后可在图面中拖动选中构件';
      }
      button.addEventListener('click', () => {
        if (action === 'copy') {
          const duplicates = items.map(item => {
            const duplicate = clone(item);
            duplicate.id = makeId(item.kind);
            duplicate.position = [round(item.position[0] + 0.4), round(item.position[1] + 0.4)];
            if (['door', 'window'].includes(duplicate.kind)) duplicate.position = constrainOpeningToWall(duplicate, duplicate.position);
            return duplicate;
          });
          currentData().items.push(...duplicates);
          selectedIds = new Set(duplicates.map(item => item.id));
          selectedId = duplicates.at(-1)?.id || '';
          movingId = '';
        } else if (action === 'move') {
          movingId = movingId === 'selection' ? '' : 'selection';
        } else items.forEach(item => { item[action] = !item[action]; });
        renderAll();
        showProperties();
      });
      row.appendChild(button);
    });
    properties.appendChild(row);
  }

  function explodeSelection(items) {
    const data = currentData();
    const sources = items.filter(item => !['floor', 'camera'].includes(item.kind));
    if (!sources.length) return;
    const exploded = [];
    sources.forEach(source => {
      const object = buildItem({ ...clone(source), id: `explode-source-${source.id}` });
      if (!object) return;
      object.updateWorldMatrix(true, true);
      object.traverse(mesh => {
        if (!mesh.isMesh) return;
        const addPrimitive = matrix => {
          const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
          matrix.decompose(position, quaternion, scale);
          const cylinder = mesh.geometry?.type === 'CylinderGeometry';
          const rotation = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ');
          exploded.push({ id: makeId(cylinder ? 'cylinder' : 'cube'), kind: cylinder ? 'cylinder' : 'cube', componentType: cylinder ? 'cylinder' : 'cube', position: [round(position.x), round(position.z)], elevation: round(position.y - Math.abs(scale.y) / 2), size: [round(Math.abs(scale.x)), round(Math.abs(scale.z))], height: round(Math.abs(scale.y)), rotation: cylinder ? 0 : rotation.y, color: `#${new THREE.Color(mesh.material?.color || 0x678c87).getHexString()}`, opacity: mesh.material?.opacity ?? 1 });
        };
        if (mesh.isInstancedMesh) {
          const instanceMatrix = new THREE.Matrix4();
          for (let index = 0; index < mesh.count; index += 1) { mesh.getMatrixAt(index, instanceMatrix); addPrimitive(new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, instanceMatrix)); }
        } else addPrimitive(mesh.matrixWorld);
      });
      if (source.kind === 'other' && Array.isArray(source.parts) && !exploded.length) source.parts.forEach(part => {
        const p = part.position || [0, (part.size?.[1] || 1) / 2, 0], cylinder = part.shape === 'cylinder';
        exploded.push({ id: makeId(cylinder ? 'cylinder' : 'cube'), kind: cylinder ? 'cylinder' : 'cube', componentType: cylinder ? 'cylinder' : 'cube', position: [round(source.position[0] + p[0]), round(source.position[1] + p[2])], elevation: round(p[1] - part.size[1] / 2), size: [part.size[0], cylinder ? part.size[2] || part.size[0] : part.size[2]], height: part.size[1], rotation: part.rotation?.[1] || 0, color: part.color || part.material || source.color || '#678c87', opacity: part.opacity ?? source.opacity ?? 1 });
      });
      disposeObject(object);
    });
    data.items = data.items.filter(item => !sources.includes(item)).concat(exploded);
    selectedIds = new Set(exploded.map(item => item.id)); selectedId = exploded.at(-1)?.id || '';
    showProperties(); renderAll();
  }

  function combineSelection(items) {
    if (items.length < 2) return;
    const center = items.reduce((sum, item) => [sum[0] + item.position[0], sum[1] + item.position[1]], [0, 0]).map(value => value / items.length);
    const parts = [];
    items.forEach(item => {
      const object = buildItem({ ...clone(item), id: `combine-source-${item.id}` });
      object.updateWorldMatrix(true, true);
      object.traverse(mesh => {
        if (!mesh.isMesh) return;
        const addPart = matrix => {
          const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
          matrix.decompose(position, quaternion, scale);
          const cylinder = mesh.geometry?.type === 'CylinderGeometry';
          const rotation = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ');
          parts.push({ shape: cylinder ? 'cylinder' : 'cube', size: [round(Math.abs(scale.x)), round(Math.abs(scale.y)), round(Math.abs(scale.z))], position: [round(position.x - center[0]), round(position.y), round(position.z - center[1])], rotation: [0, cylinder ? 0 : rotation.y, 0], color: `#${new THREE.Color(mesh.material?.color || 0x678c87).getHexString()}`, opacity: mesh.material?.opacity ?? 1 });
        };
        if (mesh.isInstancedMesh) {
          const instanceMatrix = new THREE.Matrix4();
          for (let index = 0; index < mesh.count; index += 1) { mesh.getMatrixAt(index, instanceMatrix); addPart(new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, instanceMatrix)); }
        } else addPart(mesh.matrixWorld);
      });
      disposeObject(object);
    });
    const group = { id: makeId('other'), kind: 'other', componentType: 'other', position: [round(center[0]), round(center[1])], size: [1, 1], height: 1, parts };
    currentData().items = currentData().items.filter(item => !items.includes(item)).concat(group);
    selectedIds = new Set([group.id]); selectedId = group.id; showProperties(); renderAll();
  }

  function structureButtons(items) {
    const row = document.createElement('div'); row.className = 'editor-transform';
    [['炸开', () => explodeSelection(items)], ['组合', () => combineSelection(items)]].forEach(([label, action]) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', action); row.appendChild(button); });
    properties.appendChild(row);
  }

  function showProperties() {
    properties.innerHTML = '';
    const data = currentData();
    if (selectedId === 'background' && data.background) {
      const background = data.background;
      modeLabel.textContent = '底图参数';
      modeHelp.textContent = movingId === 'background' ? '移动已启用，可在图面中拖动底图' : '点击移动按钮后可拖动，参数修改即时生效';
      field('位置 X', background.position[0], value => { background.position[0] = value; renderAll(); });
      field('位置 Z', background.position[1], value => { background.position[1] = value; renderAll(); });
      field('宽度', background.width, value => { background.width = Math.max(0.1, value); renderAll(); }, { min: 0.1 });
      field('深度', background.depth, value => { background.depth = Math.max(0.1, value); renderAll(); }, { min: 0.1 });
      field('旋转', THREE.MathUtils.radToDeg(background.rotation || 0), value => { background.rotation = THREE.MathUtils.degToRad(value); renderAll(); }, { step: 1, unit: '°' });
      field('透明度', background.opacity ?? 0.45, value => { background.opacity = Math.min(1, Math.max(0.05, value)); renderAll(); }, { min: 0.05, max: 1, step: 0.05, unit: '' });
      const moveRow = document.createElement('div');
      moveRow.className = 'editor-transform';
      const moveButton = document.createElement('button');
      moveButton.type = 'button';
      moveButton.textContent = '移动';
      moveButton.title = '启用后可在图面中拖动底图';
      moveButton.setAttribute('aria-pressed', String(movingId === 'background'));
      moveButton.addEventListener('click', () => {
        movingId = movingId === 'background' ? '' : 'background';
        showProperties();
        renderAll();
      });
      moveRow.appendChild(moveButton);
      properties.appendChild(moveRow);
      const remove = document.createElement('button');
      remove.className = 'editor-delete';
      remove.type = 'button';
      remove.textContent = '删除底图';
      remove.addEventListener('click', () => {
        delete currentData().background;
        activeKind = '';
        clearSelection();
        blueprintVisible.checked = false;
        updateCategoryButtons();
        showProperties();
        renderAll();
      });
      properties.appendChild(remove);
      return;
    }
    const selection = selectedItems();
    if (selection.length > 1) {
      const sameKind = selection.every(item => item.kind === selection[0].kind);
      const kind = sameKind ? selection[0].kind : '';
      modeLabel.textContent = sameKind ? `${TYPES[kind]?.label || kind} · 已选 ${selection.length} 个` : `已选 ${selection.length} 个不同构件`;
      modeHelp.textContent = movingId === 'selection' ? '移动已启用，拖动任一选中构件可整体移动' : sameKind ? '属性修改会同时应用到全部选中构件' : '显示共同属性与可共同执行的命令';
      batchField('位置 X', selection, item => item.position[0], (item, value) => { item.position = ['door', 'window'].includes(item.kind) ? constrainOpeningToWall(item, [value, item.position[1]]) : [value, item.position[1]]; });
      batchField('位置 Z', selection, item => item.position[1], (item, value) => { item.position = ['door', 'window'].includes(item.kind) ? constrainOpeningToWall(item, [item.position[0], value]) : [item.position[0], value]; });
      if (sameKind && kind === 'floor') {
        batchField('外扩尺寸', selection, item => item.offset ?? 0.3, (item, value) => { item.offset = Math.max(0, value); }, { min: 0 });
        batchField('厚度', selection, item => item.height ?? 0.1, (item, value) => { item.height = Math.max(0.02, value); }, { min: 0.02 });
      } else if (sameKind && kind === 'camera') {
        batchField('高度', selection, item => item.cameraHeight ?? 1.65, (item, value) => { item.cameraHeight = Math.max(0.1, value); }, { min: 0.1 });
        batchField('焦距', selection, item => item.focalLength ?? 35, (item, value) => { item.focalLength = Math.max(1, value); }, { min: 1, step: 1, unit: 'mm' });
        batchField('目标 X', selection, item => item.target?.[0] ?? item.position[0], (item, value) => { item.target ||= [...item.position]; item.target[0] = value; });
        batchField('目标 Z', selection, item => item.target?.[1] ?? item.position[1], (item, value) => { item.target ||= [...item.position]; item.target[1] = value; });
      } else if (sameKind && kind === 'lShapedOfficeDesk') {
        selection.forEach(normalizeLShapedOfficeDesk);
        batchField('主桌长度', selection, item => item.mainLength, (item, value) => { item.mainLength = Math.max(1, value); normalizeLShapedOfficeDesk(item); }, { min: 1 });
        batchField('回转桌长度', selection, item => item.returnLength, (item, value) => { item.returnLength = Math.max(1, value); normalizeLShapedOfficeDesk(item); }, { min: 1 });
        batchField('桌面深度', selection, item => item.deskDepth, (item, value) => { item.deskDepth = Math.max(0.45, value); normalizeLShapedOfficeDesk(item); }, { min: 0.45 });
        batchField('桌面高度', selection, item => item.deskHeight, (item, value) => { item.deskHeight = Math.max(0.55, value); normalizeLShapedOfficeDesk(item); }, { min: 0.55 });
        batchField('磨砂挡板高', selection, item => item.screenHeight, (item, value) => { item.screenHeight = Math.max(0.15, value); normalizeLShapedOfficeDesk(item); }, { min: 0.15 });
        batchField('椅子前后', selection, item => item.chairOffset, (item, value) => { item.chairOffset = value; });
      } else if (sameKind && kind === 'pillar') {
        selection.forEach(normalizePillar);
        const shape = selection[0].pillarShape;
        const mixedShape = selection.some(item => item.pillarShape !== shape);
        selectField('形状', mixedShape ? '' : shape, value => {
          selection.forEach(item => { item.pillarShape = value; normalizePillar(item); });
          showProperties(); renderAll();
        }, mixedShape, [['square', '方柱'], ['round', '圆柱']]);
        if (!mixedShape && shape === 'round') batchField('直径', selection, item => item.size[0], (item, value) => { item.size = [Math.max(0.05, value), Math.max(0.05, value)]; }, { min: 0.05 });
        else {
          batchField('长度', selection, item => item.size[0], (item, value) => { item.size[0] = Math.max(0.05, value); }, { min: 0.05 });
          batchField('宽度', selection, item => item.size[1], (item, value) => { item.size[1] = Math.max(0.05, value); }, { min: 0.05 });
        }
        batchField('高度', selection, () => getActiveModel().height, () => {}, { min: 0.05, disabled: true });
      } else if (sameKind && (kind === 'coffeeTable' || kind === 'backlessSofa')) {
        selection.forEach(normalizeRoundFurniture);
        const shape = selection[0].shape;
        const mixedShape = selection.some(item => item.shape !== shape);
        selectField('形状', mixedShape ? '' : shape, value => {
          selection.forEach(item => { item.shape = value; normalizeRoundFurniture(item); });
          showProperties(); renderAll();
        }, mixedShape, [['rectangular', '矩形'], ['round', '圆形']]);
        if (!mixedShape && shape === 'round') batchField('直径', selection, item => item.size[0], (item, value) => { item.size = [Math.max(0.05, value), Math.max(0.05, value)]; }, { min: 0.05 });
        else {
          batchField('长度', selection, item => item.size[0], (item, value) => { item.size[0] = Math.max(0.05, value); }, { min: 0.05 });
          batchField('宽度', selection, item => item.size[1], (item, value) => { item.size[1] = Math.max(0.05, value); }, { min: 0.05 });
        }
        batchField('高度', selection, item => item.height, (item, value) => { item.height = Math.max(0.05, value); }, { min: 0.05 });
      } else if (sameKind) {
        batchField('长度', selection, item => item.size[0], (item, value) => { item.size[0] = Math.max(0.05, value); }, { min: 0.05 });
        batchField('宽度', selection, item => item.size[1], (item, value) => { item.size[1] = Math.max(0.05, value); }, { min: 0.05 });
        batchField('高度', selection, item => kind === 'curtainWall' ? getActiveModel().height : item.height, (item, value) => { item.height = Math.max(0.05, value); }, { min: 0.05, disabled: kind === 'curtainWall' });
        if (kind === 'window') batchField('窗底墙高', selection, item => item.sillHeight ?? 0.66, (item, value) => { item.sillHeight = Math.max(0, value); }, { min: 0 });
        if (kind === 'door') batchField('开合角度', selection, item => item.openAngle ?? 0, (item, value) => { item.openAngle = Math.min(180, Math.max(0, value)); }, { min: 0, max: 180, step: 1, unit: '°' });
      }
      if (kind !== 'floor' && kind !== 'camera') batchField('旋转', selection, item => THREE.MathUtils.radToDeg(item.rotation || 0), (item, value) => { item.rotation = THREE.MathUtils.degToRad(value); }, { step: 1, unit: '°', disabled: ['door', 'window'].includes(kind) });
      if (sameKind && ['wall', 'curtainWall'].includes(kind)) {
        selection.forEach(item => { item.wallSide ||= item.sourceWall || inferCardinalSide(item); });
        const side = selection[0].wallSide;
        const mixed = selection.some(item => item.wallSide !== side);
        selectField('方位', mixed ? '' : side, value => { selection.forEach(item => { item.wallSide = value; item.sourceWall = value; }); renderAll(); }, mixed);
      }
      transformButtons(selection);
      selection.forEach(item => { if (item.kind !== 'other') itemColorFields(item); });
      structureButtons(selection);
      const remove = document.createElement('button');
      remove.className = 'editor-delete'; remove.type = 'button'; remove.textContent = `删除选中构件 (${selection.length})`;
      remove.addEventListener('click', () => { data.items = data.items.filter(item => !selectedIds.has(item.id)); clearSelection(); showProperties(); renderAll(); });
      properties.appendChild(remove);
      return;
    }
    const item = currentItem();
    if (item?.kind === 'floor') {
      modeLabel.textContent = '地板 · 编辑';
      modeHelp.textContent = '调整外扩尺寸，地板会沿多段线自动封闭';
      field('外扩尺寸', item.offset ?? 0.3, value => { item.offset = Math.max(0, value); renderAll(); }, { min: 0, step: 0.05 });
      field('厚度', item.height ?? 0.1, value => { item.height = Math.max(0.02, value); renderAll(); }, { min: 0.02 });
      const remove = document.createElement('button');
      remove.className = 'editor-delete'; remove.type = 'button'; remove.textContent = '删除选中地板';
      remove.addEventListener('click', () => { currentData().items = currentData().items.filter(candidate => candidate.id !== item.id); activeKind = ''; clearSelection(); updateCategoryButtons(); showProperties(); renderAll(); });
      properties.appendChild(remove); return;
    }
    if (item?.kind === 'camera') {
      modeLabel.textContent = '相机 · 编辑';
      modeHelp.textContent = '调整位置、高度、焦距和朝向';
      field('位置 X', item.position[0], value => { item.position[0] = value; renderAll(); });
      field('位置 Z', item.position[1], value => { item.position[1] = value; renderAll(); });
      field('高度', item.cameraHeight ?? 1.65, value => { item.cameraHeight = Math.max(0.1, value); renderAll(); }, { min: 0.1 });
      field('焦距', item.focalLength ?? 35, value => { item.focalLength = Math.max(1, value); renderAll(); }, { min: 1, step: 1, unit: 'mm' });
      field('目标 X', item.target?.[0] ?? item.position[0], value => { item.target ||= [item.position[0], item.position[1] - 1]; item.target[0] = value; renderAll(); });
      field('目标 Z', item.target?.[1] ?? item.position[1] - 1, value => { item.target ||= [item.position[0], item.position[1] - 1]; item.target[1] = value; renderAll(); });
      const viewButton = document.createElement('button');
      viewButton.className = 'editor-view-camera'; viewButton.type = 'button'; viewButton.textContent = '查看此相机视角';
      viewButton.addEventListener('click', () => cameraView(item)); properties.appendChild(viewButton);
      const remove = document.createElement('button');
      remove.className = 'editor-delete'; remove.type = 'button'; remove.textContent = '删除选中相机';
      remove.addEventListener('click', () => { currentData().items = currentData().items.filter(candidate => candidate.id !== item.id); clearSelection(); showProperties(); renderAll(); });
      properties.appendChild(remove); return;
    }
    if (item) {
      modeLabel.textContent = `${TYPES[item.kind]?.label || item.kind} · 编辑`;
      modeHelp.textContent = movingId === 'mullion' ? '拖动立樘沿幕墙移动，分格间距限制为 1–2 m' : movingId === 'selection' ? '移动已启用，可在图面中拖动；再次点击移动可关闭' : '点击移动按钮后可拖动，参数修改即时生效';
      field('位置 X', item.position[0], value => { item.position = ['door', 'window'].includes(item.kind) ? constrainOpeningToWall(item, [value, item.position[1]]) : [value, item.position[1]]; renderAll(); });
      field('位置 Z', item.position[1], value => { item.position = ['door', 'window'].includes(item.kind) ? constrainOpeningToWall(item, [item.position[0], value]) : [item.position[0], value]; renderAll(); });
      if (item.kind === 'lShapedOfficeDesk') {
        normalizeLShapedOfficeDesk(item);
        field('主桌长度', item.mainLength, value => { item.mainLength = Math.max(1, value); normalizeLShapedOfficeDesk(item); renderAll(); }, { min: 1 });
        field('回转桌长度', item.returnLength, value => { item.returnLength = Math.max(1, value); normalizeLShapedOfficeDesk(item); renderAll(); }, { min: 1 });
        field('桌面深度', item.deskDepth, value => { item.deskDepth = Math.max(0.45, value); normalizeLShapedOfficeDesk(item); renderAll(); }, { min: 0.45 });
        field('桌面高度', item.deskHeight, value => { item.deskHeight = Math.max(0.55, value); normalizeLShapedOfficeDesk(item); renderAll(); }, { min: 0.55 });
        field('磨砂挡板高', item.screenHeight, value => { item.screenHeight = Math.max(0.15, value); normalizeLShapedOfficeDesk(item); renderAll(); }, { min: 0.15 });
        field('椅子前后', item.chairOffset, value => { item.chairOffset = value; renderAll(); });
      } else if (item.kind === 'pillar') {
        normalizePillar(item);
        selectField('形状', item.pillarShape, value => { item.pillarShape = value; normalizePillar(item); showProperties(); renderAll(); }, false, [['square', '方柱'], ['round', '圆柱']]);
        if (item.pillarShape === 'round') field('直径', item.size[0], value => { item.size = [Math.max(0.05, value), Math.max(0.05, value)]; renderAll(); }, { min: 0.05 });
        else {
          field('长度', item.size[0], value => { item.size[0] = Math.max(0.05, value); renderAll(); }, { min: 0.05 });
          field('宽度', item.size[1], value => { item.size[1] = Math.max(0.05, value); renderAll(); }, { min: 0.05 });
        }
        field('高度', getActiveModel().height, () => {}, { min: 0.05, disabled: true });
      } else if (item.kind === 'coffeeTable' || item.kind === 'backlessSofa') {
        normalizeRoundFurniture(item);
        selectField('形状', item.shape, value => { item.shape = value; normalizeRoundFurniture(item); showProperties(); renderAll(); }, false, [['rectangular', '矩形'], ['round', '圆形']]);
        if (item.shape === 'round') field('直径', item.size[0], value => { item.size = [Math.max(0.05, value), Math.max(0.05, value)]; renderAll(); }, { min: 0.05 });
        else {
          field('长度', item.size[0], value => { item.size[0] = Math.max(0.05, value); renderAll(); }, { min: 0.05 });
          field('宽度', item.size[1], value => { item.size[1] = Math.max(0.05, value); renderAll(); }, { min: 0.05 });
        }
        field('高度', item.height, value => { item.height = Math.max(0.05, value); renderAll(); }, { min: 0.05 });
      } else {
        field('长度', item.size[0], value => { item.size[0] = Math.max(0.05, value); renderAll(); }, { min: 0.05 });
        field('宽度', item.size[1], value => { item.size[1] = Math.max(0.05, value); renderAll(); }, { min: 0.05, disabled: ['door', 'window'].includes(item.kind) });
        field('高度', item.kind === 'curtainWall' ? getActiveModel().height : item.height, value => { item.height = Math.max(0.05, value); renderAll(); }, { min: 0.05, disabled: item.kind === 'curtainWall' });
      }
      if (item.kind === 'window') field('窗底墙高', item.sillHeight ?? 0.66, value => { item.sillHeight = Math.max(0, value); renderAll(); }, { min: 0 });
      if (item.kind === 'door') field('开合角度', item.openAngle ?? 0, value => { item.openAngle = Math.min(180, Math.max(0, value)); renderAll(); }, { min: 0, max: 180, step: 1, unit: '°' });
      if (item.kind === 'cube' || item.kind === 'cylinder') field('位置 Y', item.elevation || 0, value => { item.elevation = value; renderAll(); });
      if (item.kind === 'other' && Array.isArray(item.parts)) item.parts.forEach((part, index) => {
        colorOpacityField(`颜色 ${index + 1}`, part.color, part.opacity ?? 1, value => { part.color = value; renderAll(); }, value => { part.opacity = value; renderAll(); });
      });
      field('旋转', THREE.MathUtils.radToDeg(item.rotation || 0), value => { item.rotation = THREE.MathUtils.degToRad(value); renderAll(); }, { step: 1, unit: '°', disabled: ['door', 'window'].includes(item.kind) });
      if (item.kind === 'wall' || item.kind === 'curtainWall') {
        item.wallSide ||= item.sourceWall || inferCardinalSide(item);
        selectField('方位', item.wallSide, value => { item.wallSide = value; item.sourceWall = value; renderAll(); });
      }
      transformButtons(item);
      if (item.kind === 'curtainWall') {
        const mullionButton = document.createElement('button');
        mullionButton.className = 'editor-mullion-mode';
        mullionButton.type = 'button';
        mullionButton.textContent = movingId === 'mullion' ? '结束移动立樘' : '手动移动立樘';
        mullionButton.setAttribute('aria-pressed', String(movingId === 'mullion'));
        mullionButton.addEventListener('click', () => {
          if (movingId === 'mullion') {
            movingId = '';
            selectedMullion = null;
          } else {
            if (item.mullionMode !== 'manual') item.mullionOffsets = [...automaticMullionOffsets(item)];
            item.mullionMode = 'manual';
            item.mullionDoorSignature = curtainDoorSignature(item);
            movingId = 'mullion';
          }
          showProperties(); renderAll();
        });
        properties.appendChild(mullionButton);
        if (item.mullionMode === 'manual') {
          const autoButton = document.createElement('button');
          autoButton.className = 'editor-mullion-mode';
          autoButton.type = 'button';
          autoButton.textContent = '恢复自动排布';
          autoButton.addEventListener('click', () => {
            item.mullionMode = 'auto';
            delete item.mullionOffsets;
            delete item.mullionDoorSignature;
            selectedMullion = null;
            movingId = '';
            showProperties(); renderAll();
          });
          properties.appendChild(autoButton);
        }
      }
      if (!(item.kind === 'other' && Array.isArray(item.parts))) itemColorFields(item);
      structureButtons([item]);
      const remove = document.createElement('button');
      remove.className = 'editor-delete';
      remove.type = 'button';
      remove.textContent = '删除选中物体';
      remove.addEventListener('click', () => {
        data.items = data.items.filter(candidate => candidate.id !== item.id && candidate.hostWallId !== item.id);
        clearSelection();
        showProperties();
        renderAll();
      });
      properties.appendChild(remove);
      return;
    }
    if (activeKind && TYPES[activeKind]?.method !== 'asset') {
      const definition = defaults[activeKind];
      modeLabel.textContent = `${TYPES[activeKind].label} · ${mode === 'create' ? '绘制' : '选择'}`;
      modeHelp.textContent = mode === 'create' ? (activeKind === 'floor' ? '左键连续点击角点，右键结束并自动封闭' : activeKind === 'camera' ? '左键点击相机位置，移动调整视角，再次点击确定' : activeKind === 'door' || activeKind === 'window' ? '在已有墙体附近单击放置，自动嵌入并切分墙体' : '第一次点击定位，第二次点击确定长度或方向') : '点击图面元素进行选择和编辑';
      if (mode === 'create') {
        if (activeKind === 'floor') field('默认外扩', definition.offset ?? 0.3, value => { definition.offset = Math.max(0, value); }, { min: 0, step: 0.05 });
        else if (activeKind === 'camera') {
          field('默认焦距', definition.focalLength ?? 35, value => { definition.focalLength = Math.max(1, value); }, { min: 1, step: 1, unit: 'mm' });
          field('默认高度', definition.cameraHeight ?? 1.65, value => { definition.cameraHeight = Math.max(0.1, value); }, { min: 0.1 });
        } else if (activeKind === 'lShapedOfficeDesk') {
          field('默认主桌长', definition.length, value => { definition.length = Math.max(1, value); }, { min: 1 });
          field('默认回转长', definition.width, value => { definition.width = Math.max(1, value); }, { min: 1 });
          field('默认桌面深', definition.deskDepth, value => { definition.deskDepth = Math.max(0.45, value); }, { min: 0.45 });
          field('默认桌面高', definition.deskHeight, value => { definition.deskHeight = Math.max(0.55, value); }, { min: 0.55 });
          field('默认挡板高', definition.screenHeight, value => { definition.screenHeight = Math.max(0.15, value); }, { min: 0.15 });
        } else if (activeKind === 'pillar') {
          selectField('默认形状', definition.pillarShape, value => { definition.pillarShape = value; if (value === 'round') definition.width = definition.length; showProperties(); }, false, [['square', '方柱'], ['round', '圆柱']]);
          if (definition.pillarShape === 'round') field('默认直径', definition.length, value => { definition.length = Math.max(0.05, value); definition.width = definition.length; }, { min: 0.05 });
          else {
            field('默认长度', definition.length, value => { definition.length = Math.max(0.05, value); }, { min: 0.05 });
            field('默认宽度', definition.width, value => { definition.width = Math.max(0.05, value); }, { min: 0.05 });
          }
          field('高度', getActiveModel().height, () => {}, { min: 0.05, disabled: true });
        } else if (activeKind === 'coffeeTable' || activeKind === 'backlessSofa') {
          selectField('默认形状', definition.shape, value => { definition.shape = value; if (value === 'round') definition.width = definition.length; showProperties(); }, false, [['rectangular', '矩形'], ['round', '圆形']]);
          if (definition.shape === 'round') field('默认直径', definition.length, value => { definition.length = Math.max(0.05, value); definition.width = definition.length; }, { min: 0.05 });
          else {
            field('默认长度', definition.length, value => { definition.length = Math.max(0.05, value); }, { min: 0.05 });
            field('默认宽度', definition.width, value => { definition.width = Math.max(0.05, value); }, { min: 0.05 });
          }
          field('默认高度', definition.height, value => { definition.height = Math.max(0.05, value); }, { min: 0.05 });
        } else {
          field('默认长度', definition.length, value => { definition.length = Math.max(0.05, value); }, { min: 0.05 });
          field('默认宽度', definition.width, value => { definition.width = Math.max(0.05, value); }, { min: 0.05 });
          field('默认高度', activeKind === 'curtainWall' ? getActiveModel().height : definition.height, value => { definition.height = Math.max(0.05, value); }, { min: 0.05, disabled: activeKind === 'curtainWall' });
          if (activeKind === 'window') field('窗底墙高', definition.sillHeight ?? 0.66, value => { definition.sillHeight = Math.max(0, value); }, { min: 0 });
          if (activeKind === 'door') field('默认开合角', definition.openAngle ?? 0, value => { definition.openAngle = Math.min(180, Math.max(0, value)); }, { min: 0, max: 180, step: 1, unit: '°' });
        }
      }
    } else {
      modeLabel.textContent = '选择一个类别';
      modeHelp.textContent = '点击类别开始绘制，再次点击进入编辑状态';
    }
  }

  function updateCategoryButtons() {
    categories.querySelectorAll('button').forEach(button => {
      const active = button.dataset.kind === activeKind;
      const candidates = currentData().items.filter(item => item.kind === button.dataset.kind);
      const categorySelected = candidates.length > 0 && candidates.every(item => selectedIds.has(item.id));
      const selectedUniqueItem = selectedId === 'background'
        ? button.dataset.kind === 'background'
        : currentItem()?.kind === 'floor' && button.dataset.kind === 'floor';
      const uniqueItem = button.dataset.kind === 'background'
        ? currentData().background
        : button.dataset.kind === 'floor' ? currentFloor() : null;
      button.textContent = uniqueItem ? `选择${TYPES[button.dataset.kind].label}` : TYPES[button.dataset.kind].label;
      button.setAttribute('aria-pressed', String((active && (mode === 'create' || selectedUniqueItem)) || categorySelected));
      button.dataset.mode = 'create';
    });
    importBlueprint.textContent = currentData().background ? '选择底图' : '导入底图';
    blueprintVisible.disabled = !currentData().background;
  }

  function selectItem(id, additive = false) {
    if (additive && !id) return;
    const item = id && id !== 'background' ? currentData().items.find(candidate => candidate.id === id) : null;
    if (!item || item.id !== selectedMullion?.wallId) selectedMullion = null;
    const exclusive = id === 'background' || item?.kind === 'floor';
    const hasExclusiveSelection = selectedId === 'background' || selectedItems().some(candidate => candidate.kind === 'floor');
    activeKind = id === 'background' ? 'background' : item?.kind === 'floor' ? 'floor' : '';
    if (!id) {
      selectedIds = new Set();
      selectedId = '';
      movingId = '';
    } else if (exclusive) {
      if (selectedId !== id) movingId = '';
      selectedIds = new Set([id]);
      selectedId = id;
    } else if (additive) {
      movingId = '';
      if (hasExclusiveSelection) selectedIds.clear();
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      selectedId = selectedIds.has(id) ? id : [...selectedIds].at(-1) || '';
    } else {
      if (!selectedIds.has(id) || selectedIds.size !== 1) movingId = '';
      selectedIds = new Set([id]);
      selectedId = id;
    }
    mode = 'select';
    updateCategoryButtons();
    showProperties();
    renderAll();
  }

  Object.entries(TYPES).forEach(([kind, type]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = type.label;
    button.dataset.kind = kind;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', event => {
      if ((event.ctrlKey || event.metaKey) && kind !== 'background') {
        const matches = currentData().items.filter(item => item.kind === kind);
        if (!matches.length) return;
        const allSelected = matches.every(item => selectedIds.has(item.id));
        if (kind === 'floor') selectedIds = allSelected ? new Set() : new Set(matches.map(item => item.id));
        else {
          if (selectedIds.has('background') || selectedItems().some(item => item.kind === 'floor')) selectedIds.clear();
          matches.forEach(item => allSelected ? selectedIds.delete(item.id) : selectedIds.add(item.id));
        }
        selectedId = [...selectedIds].at(-1) || '';
        activeKind = '';
        mode = 'select';
        movingId = '';
        updateCategoryButtons();
        showProperties();
        renderAll();
        document.querySelector('.hint').textContent = selectedIds.size ? `已选择 ${selectedIds.size} 个构件 · Ctrl + 点击类别可继续增减` : `已取消选择全部${type.label}`;
        return;
      }
      if (kind === 'background') {
        activeKind = kind;
        mode = 'select';
        const background = currentData().background;
        if (background) selectItem('background');
        else blueprintInput.click();
      } else if (kind === 'floor' && currentFloor()) {
        activeKind = kind;
        selectItem(currentFloor().id);
      } else {
        activeKind = kind;
        mode = 'create';
        clearSelection();
        draftStart = null;
        draftItem = null;
      }
      updateCategoryButtons();
      showProperties();
      renderAll();
    });
    categories.appendChild(button);
  });

  function updateDraft(point) {
    if (!draftStart || !draftItem) return;
    point = snapDrawingPoint(draftStart, point);
    if (draftItem.kind === 'floor') {
      draftItem.previewPoint = [round(point.x), round(point.z)];
      renderAll();
      return;
    }
    const dx = point.x - draftStart.x, dz = point.z - draftStart.z;
    const distance = Math.max(0.05, Math.hypot(dx, dz));
    draftItem.rotation = Math.atan2(-dz, dx);
    if (draftItem.kind === 'camera') draftItem.target = [round(point.x), round(point.z)];
    else if (TYPES[draftItem.kind].method === 'length') {
      draftItem.position = [round((draftStart.x + point.x) / 2), round((draftStart.z + point.z) / 2)];
      draftItem.size[0] = round(distance);
      if (draftItem.kind === 'lShapedOfficeDesk') {
        draftItem.mainLength = draftItem.size[0];
        normalizeLShapedOfficeDesk(draftItem);
      }
      if (draftItem.kind === 'coffeeTable' || draftItem.kind === 'backlessSofa') normalizeRoundFurniture(draftItem);
    }
    renderAll();
  }

  function finishFloor() {
    if (draftItem?.kind !== 'floor') return;
    const floor = currentFloor();
    if (floor) {
      draftStart = null;
      draftItem = null;
      activeKind = 'floor';
      selectItem(floor.id);
      document.querySelector('.hint').textContent = '当前空间已有地板，已为你选中';
      return;
    }
    if (draftItem.points.length < 3) {
      document.querySelector('.hint').textContent = '地板至少需要 3 个角点';
      return;
    }
    const center = polygonCenter(draftItem.points);
    draftItem.position = [round(center[0]), round(center[1])];
    draftItem.points = draftItem.points.map(point => [round(point[0] - center[0]), round(point[1] - center[1])]);
    delete draftItem.previewPoint;
    currentData().items.push(draftItem);
    currentData().emptySpace = true;
    selectedId = draftItem.id;
    selectedIds = new Set([draftItem.id]);
    draftStart = null;
    draftItem = null;
    mode = 'select';
    updateCategoryButtons();
    showProperties();
    renderAll();
    document.querySelector('.hint').textContent = '地板已自动封闭 · 可在参数栏调整外扩尺寸';
  }

  function beginOrFinishDrawing(point, event) {
    if (!activeKind || TYPES[activeKind].method === 'asset') return;
    const definition = defaults[activeKind];
    if (activeKind === 'door' || activeKind === 'window') {
      const match = pickHostWall(event, activeKind) || closestWall([point.x, point.z], 0.45, activeKind);
      if (!match) {
        document.querySelector('.hint').textContent = `请在已有墙体范围内点击放置${TYPES[activeKind].label}`;
        return;
      }
      const wall = match.wall, halfWall = wall.size[0] / 2, halfOpening = definition.length / 2;
      if (halfOpening > halfWall) {
        document.querySelector('.hint').textContent = `墙体长度不足，无法放置${TYPES[activeKind].label}`;
        return;
      }
      const along = Math.max(-halfWall + halfOpening, Math.min(halfWall - halfOpening, match.along));
      const overlaps = currentData().items.some(item => ['door', 'window'].includes(item.kind) && item.hostWallId === wall.id && Math.abs(wallFrame(wall, item.position).along - along) < item.size[0] / 2 + halfOpening);
      if (overlaps) {
        document.querySelector('.hint').textContent = '该位置已有门窗，请选择墙体上的空白位置';
        return;
      }
      const item = { id: makeId(activeKind), kind: activeKind, componentType: activeKind, material: DEFAULT_MATERIALS[activeKind], position: wallPoint(wall, along), size: [definition.length, wall.size[1]], height: definition.height, roomHeight: getActiveModel().height, sillHeight: activeKind === 'window' ? definition.sillHeight ?? 0.66 : 0, openAngle: activeKind === 'door' ? definition.openAngle ?? 0 : undefined, rotation: wall.rotation || 0, hostWallId: wall.id, hostWallKind: wall.kind, wallSide: wall.wallSide || wall.sourceWall, sourceWall: wall.wallSide || wall.sourceWall, mirrorX: false, mirrorZ: false };
      currentData().items.push(item);
      selectedId = item.id; selectedIds = new Set([item.id]); activeKind = ''; mode = 'select';
      updateCategoryButtons(); showProperties(); renderAll();
      document.querySelector('.hint').textContent = `${TYPES[item.kind].label}已嵌入墙体 · 点击移动后只能沿墙移动`;
      return;
    }
    if (activeKind === 'floor') {
      const floor = currentFloor();
      if (floor) {
        activeKind = 'floor';
        selectItem(floor.id);
        document.querySelector('.hint').textContent = '当前空间已有地板，已为你选中';
        return;
      }
      if (draftStart) point = snapDrawingPoint(draftStart, point);
      if (!draftItem) draftItem = { id: makeId('floor'), kind: 'floor', componentType: 'floor', material: DEFAULT_MATERIALS.floor, position: [0, 0], points: [], offset: definition.offset ?? 0.3, height: definition.height ?? 0.1 };
      draftItem.points.push([round(point.x), round(point.z)]);
      draftStart = point.clone();
      updateDraft(point);
      document.querySelector('.hint').textContent = '地板 · 已放置 ' + draftItem.points.length + ' 个角点，右键结束并自动封闭';
      return;
    }
    if (!draftStart) {
      draftStart = point.clone();
      if (activeKind === 'camera') {
        draftItem = { id: makeId('camera'), kind: 'camera', componentType: 'camera', material: DEFAULT_MATERIALS.camera, position: [round(point.x), round(point.z)], target: [round(point.x), round(point.z - 1)], focalLength: definition.focalLength ?? 35, cameraHeight: definition.cameraHeight ?? 1.65 };
      } else {
        draftItem = { id: makeId(activeKind), kind: activeKind, componentType: activeKind, material: DEFAULT_MATERIALS[activeKind], color: '#678c87', position: [round(point.x), round(point.z)], size: [definition.length, definition.width], height: activeKind === 'curtainWall' || activeKind === 'pillar' ? getActiveModel().height : definition.height, roomHeight: getActiveModel().height, sillHeight: activeKind === 'window' ? definition.sillHeight ?? 0.66 : 0, openAngle: activeKind === 'door' ? definition.openAngle ?? 0 : undefined, rotation: 0, mirrorX: false, mirrorZ: false };
        if (activeKind === 'pillar') {
          draftItem.pillarShape = definition.pillarShape;
          normalizePillar(draftItem);
        }
        if (activeKind === 'coffeeTable' || activeKind === 'backlessSofa') {
          draftItem.shape = definition.shape;
          normalizeRoundFurniture(draftItem);
        }
        if (WALL_BOUND_KINDS.has(activeKind)) draftItem.wallSide = inferCardinalSide({ position: [point.x, point.z] });
        if (activeKind === 'lShapedOfficeDesk') {
          Object.assign(draftItem, { mainLength: definition.length, returnLength: definition.width, deskDepth: definition.deskDepth, deskHeight: definition.deskHeight, screenHeight: definition.screenHeight, chairOffset: definition.chairOffset });
          normalizeLShapedOfficeDesk(draftItem);
        }
      }
      updateDraft(point);
      document.querySelector('.hint').textContent = TYPES[activeKind].label + ' · 移动鼠标预览，再次点击确定';
    } else {
      updateDraft(point);
      currentData().items.push(draftItem);
      selectedId = draftItem.id;
      selectedIds = new Set([draftItem.id]);
      draftStart = null;
      draftItem = null;
      mode = 'select';
      updateCategoryButtons();
      showProperties();
      renderAll();
      document.querySelector('.hint').textContent = '物体已创建 · 点击移动按钮后可拖动，参数栏可精确调整';
    }
  }

  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, getCamera());
    const hits = raycaster.intersectObjects(group.children, true);
    const selectableHits = hits.filter(hit => {
      const id = hit.object.userData.editorId;
      if (!id || id === 'background' || id === 'ceiling-default' || id.startsWith('ceiling-')) return false;
      const item = currentData().items.find(candidate => candidate.id === id);
      return item?.kind !== 'floor';
    });
    const firstHit = selectableHits[0];
    const hostedDoor = currentData().items.filter(item => item.kind === 'door' && item.hostWallId && HOST_WALL_KINDS.has(currentData().items.find(candidate => candidate.id === item.hostWallId)?.kind) && objectContainsPointer(objectById.get(item.id))).sort((a, b) => {
      const screenDistance = item => {
        const point = new THREE.Vector3(item.position[0], item.height / 2, item.position[1]).project(getCamera());
        return Math.hypot(point.x - pointer.x, point.y - pointer.y);
      };
      return screenDistance(a) - screenDistance(b);
    })[0];
    const openingHit = hostedDoor
      ? { object: { userData: { editorId: hostedDoor.id } } }
      : firstHit ? selectableHits.find(hit => {
        const item = currentData().items.find(candidate => candidate.id === hit.object.userData.editorId);
        return ['door', 'window'].includes(item?.kind) && hit.distance <= firstHit.distance + 0.3;
      }) : null;
    const direct = (openingHit || firstHit)?.object.userData.editorId || '';
    if (direct || viewMode !== 'top') return direct;
    const point = scenePoint(event);
    if (!point) return '';
    return closestWall([point.x, point.z], 0.38)?.wall.id || '';
  }

  function pointerHitsBackground(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, getCamera());
    return raycaster.intersectObjects(group.children, true).some(hit => hit.object.userData.editorId === 'background');
  }

  function setPointerRay(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, getCamera());
  }

  function pointerOnWall(event, wall) {
    setPointerRay(event);
    const angle = wall.rotation || 0;
    const normal = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, new THREE.Vector3(wall.position[0], 0, wall.position[1]));
    const point = new THREE.Vector3();
    return raycaster.ray.intersectPlane(plane, point) ? point : null;
  }

  function mullionScreenDrag(wall, along, event) {
    const rect = canvas.getBoundingClientRect();
    const worldAt = offset => {
      const position = wallPoint(wall, along + offset);
      return new THREE.Vector3(position[0], SECTION_HEIGHT, position[1]).project(getCamera());
    };
    const origin = worldAt(0), next = worldAt(1);
    const axisX = (next.x - origin.x) * rect.width / 2;
    const axisY = -(next.y - origin.y) * rect.height / 2;
    const axisLengthSquared = axisX * axisX + axisY * axisY;
    return {
      clientX: event.clientX,
      clientY: event.clientY,
      startAlong: along,
      axisX,
      axisY,
      axisLengthSquared
    };
  }

  function draggedMullionAlong(event) {
    if (!draggedMullion) return null;
    const drag = draggedMullion.screenDrag;
    if (drag?.axisLengthSquared > 1) {
      const deltaX = event.clientX - drag.clientX;
      const deltaY = event.clientY - drag.clientY;
      return drag.startAlong + (deltaX * drag.axisX + deltaY * drag.axisY) / drag.axisLengthSquared;
    }
    const point = viewMode === 'top' ? scenePoint(event) : pointerOnWall(event, draggedMullion.wall);
    return point ? wallFrame(draggedMullion.wall, [point.x, point.z]).along : null;
  }

  function pickMullion(event, wall, scenePosition) {
    if (!wall || wall.kind !== 'curtainWall' || wall.mullionMode !== 'manual') return null;
    setPointerRay(event);
    const wallObject = objectById.get(wall.id);
    const hit = wallObject && raycaster.intersectObject(wallObject, true).find(candidate => Number.isInteger(candidate.object.userData.mullionIndex));
    if (hit) return hit.object.userData.mullionIndex;
    if (!scenePosition) return null;
    const frame = wallFrame(wall, [scenePosition.x, scenePosition.z]);
    if (Math.abs(frame.across) > Math.max(0.35, (wall.size?.[1] || 0) / 2 + 0.2)) return null;
    const offsets = curtainMullionOffsets(wall);
    let closestIndex = null, closestDistance = 0.25;
    offsets.forEach((offset, index) => {
      const distance = Math.abs(offset - frame.along);
      if (distance <= closestDistance) { closestIndex = index; closestDistance = distance; }
    });
    return closestIndex;
  }

  function moveDraggedMullion(event) {
    if (!enabled || !draggedMullion) return false;
    const { wall, index } = draggedMullion;
    const proposedAlong = draggedMullionAlong(event);
    if (proposedAlong === null) return true;
    const nextAlong = constrainMullionOffset(wall, index, proposedAlong);
    if (nextAlong !== wall.mullionOffsets[index]) {
      wall.mullionOffsets[index] = nextAlong;
      refreshRenderedItem(wall);
      requestRender();
      document.querySelector('.hint').textContent = `第 ${index + 1} 根立樘 · 沿墙位置 ${nextAlong.toFixed(2)} m`;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }

  addEventListener('pointermove', event => { moveDraggedMullion(event); }, true);

  canvas.addEventListener('contextmenu', event => {
    if (!enabled || mode !== 'create' || activeKind !== 'floor') return;
    event.preventDefault();
    finishFloor();
  });

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (!enabled && quickHideMode) {
      event.preventDefault();
      const id = pick(event);
      if (id) {
        quickHiddenIds.add(id);
        syncHiddenIds();
        renderAll();
        document.querySelector('.hint').textContent = '已隐藏一个构件 · 继续点击可多选隐藏，点击“隐”恢复';
      }
      return;
    }
    if (!enabled) return;
    const selectionModifier = event.ctrlKey || event.metaKey;
    if (selectionModifier || viewMode === 'top') event.stopImmediatePropagation();
    const point = scenePoint(event);
    if (mode === 'create') {
      if (!point) return;
      beginOrFinishDrawing(point, event);
      return;
    }
    if (movingId === 'mullion') {
      const wall = currentItem();
      const wallPointUnderPointer = viewMode === 'top' ? point : pointerOnWall(event, wall);
      const mullionIndex = pickMullion(event, wall, wallPointUnderPointer);
      if (mullionIndex !== null) {
        event.stopImmediatePropagation();
        selectedMullion = { wallId: wall.id, index: mullionIndex };
        const startAlong = curtainMullionOffsets(wall)[mullionIndex];
        draggedMullion = { wall, index: mullionIndex, screenDrag: mullionScreenDrag(wall, startAlong, event) };
        dragging = true;
        controls.enabled = false;
        canvas.setPointerCapture?.(event.pointerId);
        refreshRenderedItem(wall);
        document.querySelector('.hint').textContent = `已选中第 ${mullionIndex + 1} 根立樘 · 按住鼠标沿幕墙拖动`;
        return;
      }
    }
    if (point && selectedId === 'background' && movingId === 'background' && pointerHitsBackground(event)) {
      const background = currentData().background;
      dragOffset.set(point.x - background.position[0], 0, point.z - background.position[1]);
      dragStartPosition = [...background.position];
      dragging = true;
      controls.enabled = false;
      return;
    }
    const id = pick(event);
    if (id && selectionModifier) {
      selectItem(id, true);
      document.querySelector('.hint').textContent = selectedIds.size > 1 ? `已选择 ${selectedIds.size} 个构件 · Ctrl + 点击继续增减选择` : 'Ctrl + 点击可继续多选构件';
      return;
    }
    if (!id && (viewMode === 'top' || selectionModifier)) {
      selectionStart = { x: event.clientX, y: event.clientY };
      selectionAdditive = selectionModifier;
      selectionBox.hidden = false;
      updateSelectionBox(event);
      controls.enabled = false;
      canvas.setPointerCapture?.(event.pointerId);
      return;
    }
    if (viewMode === 'perspective' && (movingId !== 'selection' || !id || !isSelected(id))) return;
    if (id && isSelected(id) && selectedIds.size > 1) {
      selectedId = id;
      showProperties();
      renderAll();
    } else selectItem(id);
    if (point && id !== 'background' && movingId === 'selection' && isSelected(id)) {
      const item = currentItem();
      dragOffset.set(point.x - item.position[0], 0, point.z - item.position[1]);
      dragStartPosition = [...item.position];
      dragStartPositions = new Map(selectedItems().map(candidate => [candidate.id, { position: [...candidate.position], target: candidate.target ? [...candidate.target] : null }]));
      selectedItems().filter(candidate => HOST_WALL_KINDS.has(candidate.kind)).forEach(wall => currentData().items.filter(candidate => candidate.hostWallId === wall.id).forEach(opening => {
        if (!dragStartPositions.has(opening.id)) dragStartPositions.set(opening.id, { position: [...opening.position], target: null });
      }));
      dragging = true;
      controls.enabled = false;
    }
  }, true);

  canvas.addEventListener('pointermove', event => {
    if (!enabled) return;
    if (selectionStart) {
      updateSelectionBox(event);
      return;
    }
    if (draggedMullion) return;
    const point = scenePoint(event);
    if (!point) return;
    if (draftStart) updateDraft(point);
    if (!dragging) return;
    if (selectedId === 'background') {
      const nextPosition = [round(point.x - dragOffset.x), round(point.z - dragOffset.z)];
      currentData().background.position = snapMovingPosition(dragStartPosition, nextPosition);
    } else {
      const unsnappedPosition = [round(point.x - dragOffset.x), round(point.z - dragOffset.z)];
      const nextPosition = snapMovingPosition(dragStartPosition, unsnappedPosition);
      const deltaX = nextPosition[0] - dragStartPosition[0], deltaZ = nextPosition[1] - dragStartPosition[1];
      selectedItems().forEach(item => {
        const start = dragStartPositions.get(item.id);
        if (!start) return;
        const proposed = [round(start.position[0] + deltaX), round(start.position[1] + deltaZ)];
        item.position = ['door', 'window'].includes(item.kind) ? constrainOpeningToWall(item, proposed) : proposed;
        if (HOST_WALL_KINDS.has(item.kind)) moveHostedOpenings(item, item.position[0] - start.position[0], item.position[1] - start.position[1]);
        if (start.target) item.target = [round(start.target[0] + deltaX), round(start.target[1] + deltaZ)];
      });
    }
    if (selectedId === 'background') {
      const backgroundObject = group.getObjectByName('blueprint-background');
      if (backgroundObject) backgroundObject.position.set(currentData().background.position[0], 0.035, currentData().background.position[1]);
    } else {
      const hostedOpenings = selectedItems().filter(item => ['door', 'window'].includes(item.kind) && item.hostWallId);
      if (hostedOpenings.length) {
        const affectedIds = new Set([...hostedOpenings.map(item => item.id), ...hostedOpenings.map(item => item.hostWallId)]);
        currentData().items.filter(item => affectedIds.has(item.id)).forEach(refreshRenderedItem);
      } else selectedItems().forEach(syncItemTransform);
    }
    requestRender();
  });

  addEventListener('pointerup', event => {
    if (selectionStart) {
      finishBoxSelection(event);
      return;
    }
    if (!dragging) return;
    dragging = false;
    draggedMullion = null;
    controls.enabled = true;
    showProperties();
    invalidateShadows();
    requestRender();
  });

  importBlueprint.addEventListener('click', () => {
    const background = currentData().background;
    if (background) {
      activeKind = 'background';
      selectItem('background');
    } else blueprintInput.click();
  });
  blueprintInput.addEventListener('change', async () => {
    const file = blueprintInput.files?.[0];
    if (!file) return;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const image = await new Promise((resolve, reject) => {
      const value = new Image();
      value.onload = () => resolve(value);
      value.onerror = reject;
      value.src = dataUrl;
    });
    const model = getActiveModel();
    const width = model.width;
    currentData().background = { name: file.name, dataUrl, visible: true, position: [0, 0], width, depth: round(width * image.height / image.width), rotation: 0, opacity: 0.45 };
    blueprintVisible.checked = true;
    activeKind = 'background';
    selectItem('background');
    blueprintInput.value = '';
    document.querySelector('.hint').textContent = `已导入底图 ${file.name} · 可拖动或在参数栏缩放`;
  });

  blueprintVisible.addEventListener('change', () => {
    const background = currentData().background;
    if (background) background.visible = blueprintVisible.checked;
    renderAll();
  });

  document.querySelector('#saveEditorData').addEventListener('click', requestSave);

  function enter() {
    quickHideMode = false;
    quickHiddenIds.clear();
    enabled = true;
    viewMode = 'top';
    ensureEditorData(getActiveModel());
    syncPanel();
    panel.hidden = false;
    modelPanel.hidden = true;
    outputPanel.hidden = true;
    overlay.hidden = true;
    group.visible = true;
    architecture.visible = false;
    furniture.visible = false;
    renderer.localClippingEnabled = true;
    renderer.clippingPlanes = [sectionPlane];
    document.body.classList.add('edit-mode');
    document.querySelector('#editView').setAttribute('aria-pressed', 'true');
    blueprintVisible.checked = currentData().background?.visible !== false;
    orthogonalSnap.checked = currentData().orthogonalSnap !== false;
    showTopView();
    showProperties();
    renderAll();
    updateCategoryButtons();
    document.querySelector('.hint').textContent = '1.5 m 剖切俯视 · 点击选择 · 拖动空白处框选 · Ctrl 可追加选择';
  }

  function exit() {
    quickHideMode = false;
    quickHiddenIds.clear();
    enabled = false;
    draftStart = null;
    draftItem = null;
    dragging = false;
    selectionStart = null;
    selectionBox.hidden = true;
    selectionBox.classList.remove('is-crossing');
    movingId = '';
    controls.enabled = true;
    renderer.clippingPlanes = [];
    clearSelection();
    const hasEditorData = Array.isArray(getActiveModel()?.editor?.items);
    group.visible = hasEditorData;
    architecture.visible = !hasEditorData;
    furniture.visible = !hasEditorData;
    panel.hidden = true;
    modelPanel.hidden = false;
    document.body.classList.remove('edit-mode');
    document.querySelector('#editView').setAttribute('aria-pressed', 'false');
    renderAll();
    document.querySelector('.hint').textContent = '拖动旋转 · 滚轮缩放 · 中键平移';
  }

  orthogonalSnap.addEventListener('change', () => { currentData().orthogonalSnap = orthogonalSnap.checked; });

  document.querySelector('#editView').addEventListener('click', () => enabled ? exit() : enter());
  document.querySelector('#closeEditor').addEventListener('click', exit);

  return {
    get enabled() { return enabled; },
    getQuickHideMode() { return quickHideMode; },
    clearQuickHidden() {
      quickHiddenIds.clear();
      syncHiddenIds();
      renderAll();
    },
    getHiddenItemIds() { return [...quickHiddenIds]; },
    setHiddenItemIds(ids) {
      quickHiddenIds = new Set(Array.isArray(ids) ? ids : []);
      syncHiddenIds();
      renderAll();
    },
    refreshOutlines() { renderSignatures.clear(); renderAll(); },
    enter,
    exit,
    syncRoomHeight(height) {
      const model = getActiveModel();
      if (!model?.editor?.items) return;
      ensureEditorData(model);
      currentData().items.forEach(item => {
        if (item.kind === 'wall') { item.height = height; item.y = height / 2; }
        if (item.kind === 'window' || item.kind === 'curtainWall' || item.kind === 'door') item.roomHeight = height;
        if (item.kind === 'curtainWall') item.height = height;
        if (item.kind === 'pillar') { item.height = height; item.y = height / 2; }
      });
      renderAll();
    },
    toggleQuickHideMode() {
      if (quickHideMode) {
        quickHideMode = false;
      } else {
        const model = getActiveModel();
        ensureEditorData(model);
        quickHiddenIds = new Set(currentData().hiddenItemIds || []);
        quickHideMode = true;
        architecture.visible = false;
        furniture.visible = false;
        group.visible = true;
      }
      renderAll();
      return quickHideMode;
    },
    setPanelVisible(visible) {
      panel.hidden = !visible;
      if (visible) modelPanel.hidden = true;
    },
    setPerspectiveView() {
      if (!enabled) return;
      viewMode = 'perspective';
      renderer.clippingPlanes = [];
      architecture.visible = false;
      furniture.visible = false;
      group.visible = true;
      renderAll();
      document.querySelector('.hint').textContent = '透视编辑 · 左键旋转 · Ctrl + 点击或框选构件 · 中键平移';
    },
    setTopView() {
      if (!enabled) return;
      viewMode = 'top';
      renderer.localClippingEnabled = true;
      renderer.clippingPlanes = [sectionPlane];
      showTopView();
      renderAll();
      document.querySelector('.hint').textContent = '1.5 m 剖切俯视 · 点击选择 · 拖动空白处框选 · Ctrl 可追加选择';
    },
    getWallVisibility() {
      const data = currentData();
      return Object.fromEntries(['north', 'south', 'east', 'west'].map(side => [side, data.wallVisibility?.[side] !== false]));
    },
    setWallVisibility(side, visible) {
      const data = currentData();
      data.wallVisibility ||= {};
      data.wallVisibility[side] = Boolean(visible);
      renderAll();
      return data.wallVisibility[side];
    },
    getCeilingVisibility() {
      return Boolean(currentData().ceilingVisible);
    },
    setCeilingVisibility(visible) {
      currentData().ceilingVisible = Boolean(visible);
      renderAll();
      return currentData().ceilingVisible;
    },
    refresh() {
      const model = getActiveModel();
      if (!model) return;
      if (!enabled) {
        const hasEditorData = Array.isArray(model.editor?.items);
        architecture.visible = !hasEditorData;
        furniture.visible = !hasEditorData;
        group.visible = hasEditorData;
        renderAll();
        return;
      }
      clearSelection();
      activeKind = '';
      mode = 'select';
      ensureEditorData(getActiveModel());
      quickHiddenIds = new Set(currentData().hiddenItemIds || []);
      blueprintVisible.checked = currentData().background?.visible !== false;
      updateCategoryButtons();
      showProperties();
      if (viewMode === 'top') {
        renderer.clippingPlanes = [sectionPlane];
        showTopView();
        document.querySelector('.hint').textContent = '1.5 m 剖切俯视 · 点击选择 · 拖动空白处框选 · Ctrl 可追加选择';
      } else {
        renderer.clippingPlanes = [];
        document.querySelector('.hint').textContent = '透视编辑 · 左键旋转 · Ctrl + 点击或框选构件 · 中键平移';
      }
      renderAll();
    }
  };
}


