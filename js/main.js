// main.js - 装箱辅助软件主逻辑
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DragControls } from 'three/addons/controls/DragControls.js';
import { Packer, overlap } from './packer.js';

// ---------- 状态 ----------
const state = {
  container: { L: 12000, W: 2350, H: 2390 },
  cargoDef: [],          // [{id,name,l,w,h,qty,color}]
  placed: [],            // [{instanceId,baseId,name,color,x,y,z,l,w,h}]
  mode: 'auto',          // 'auto' | 'manual'
  selected: null,        // 当前选中 mesh
  stepIndex: 0,          // 逐步指引显示到第几件
  nextId: 1,
};
const meshByInst = new Map(); // instanceId -> THREE.Mesh

// ---------- 3D 场景 ----------
const canvas = document.getElementById('three-canvas');
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
} catch (e) {
  console.warn('WebGL 不可用，3D 渲染关闭，其它逻辑仍可用：', e.message);
  showNoWebGLBanner();
}
const viewEl = renderer ? renderer.domElement : canvas; // 交互用 DOM 元素（无 WebGL 时退回 canvas）
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe8eaf0);
const camera = new THREE.PerspectiveCamera(50, 1, 1, 1_000_000);
const controls = new OrbitControls(camera, viewEl);
controls.enableDamping = true;

function showNoWebGLBanner() {
  const b = document.createElement('div');
  b.style.cssText = 'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:20;background:#fff3e0;border:1px solid #ffb665;color:#a64b00;padding:6px 12px;border-radius:4px;font-size:12px';
  b.textContent = '当前环境不支持 WebGL，3D 无法渲染，装箱/统计/方案逻辑仍可用';
  document.getElementById('viewer').appendChild(b);
}

// 光照
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dir = new THREE.DirectionalLight(0xffffff, 0.7);
dir.position.set(1, 2, 1); scene.add(dir);

// 网格地面
let grid, containerMesh;
function buildContainer() {
  if (grid) scene.remove(grid);
  if (containerMesh) scene.remove(containerMesh);
  const { L, W, H } = state.container;
  // 地面网格（按容器大小）
  grid = new THREE.GridHelper(Math.max(L, W) * 2, 40, 0x9aa3b2, 0xc9cdd4);
  grid.position.set(L / 2, 0, W / 2);
  scene.add(grid);
  // 容器线框
  const geo = new THREE.BoxGeometry(L, H, W);
  const edges = new THREE.EdgesGeometry(geo);
  const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x165dff }));
  line.position.set(L / 2, H / 2, W / 2);
  containerMesh = line;
  scene.add(containerMesh);
  // 半透明地板
  const floorGeo = new THREE.PlaneGeometry(L, W);
  const floor = new THREE.Mesh(floorGeo, new THREE.MeshBasicMaterial({ color: 0xb6c6e8, transparent: true, opacity: 0.3, side: THREE.DoubleSide }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(L / 2, 0, W / 2);
  floor.name = 'floor';
  containerMesh.add(floor);
  // 后/左墙淡线，便于观察方位
  // 相机重定位
  const d = Math.max(L, W, H) * 1.6;
  camera.position.set(L * 0.9, H * 1.8, W * 1.5 + d * 0.4);
  controls.target.set(L / 2, H / 2, W / 2);
  controls.update();
}
buildContainer();

// ---------- 货物 Mesh ----------
function makeBoxMesh(item) {
  const geo = new THREE.BoxGeometry(item.l, item.h, item.w);
  const mat = new THREE.MeshLambertMaterial({ color: item.color, transparent: true, opacity: 0.92 });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(item.x + item.l / 2, item.y + item.h / 2, item.z + item.w / 2);
  m.userData = { instanceId: item.instanceId, baseId: item.baseId, name: item.name, color: item.color };
  // 边线
  const eg = new THREE.EdgesGeometry(geo);
  m.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x222222 })));
  return m;
}

function syncMeshesFromPlaced() {
  // 移除多余
  const keep = new Set(state.placed.map(p => p.instanceId));
  for (const [id, m] of meshByInst) {
    if (!keep.has(id)) { scene.remove(m); meshByInst.delete(id); }
  }
  // 新增/更新
  for (const it of state.placed) {
    let m = meshByInst.get(it.instanceId);
    if (!m) {
      m = makeBoxMesh(it);
      scene.add(m);
      meshByInst.set(it.instanceId, m);
    } else {
      m.position.set(it.x + it.l / 2, it.y + it.h / 2, it.z + it.w / 2);
    }
    m.visible = true;
  }
}

// ---------- 碰撞/边界检测 ----------
function validPosition(item, exceptInstanceId) {
  const { L, W, H } = state.container;
  if (item.x < -1e-6 || item.z < -1e-6 || item.y < -1e-6) return false;
  if (item.x + item.l > L + 1e-6) return false;
  if (item.z + item.w > W + 1e-6) return false;
  if (item.y + item.h > H + 1e-6) return false;
  for (const p of state.placed) {
    if (p.instanceId === exceptInstanceId) continue;
    if (overlap(item, p)) return false;
  }
  return true;
}

// ---------- 拖拽控件（手动模式） ----------
const dragObjs = [];
const drag = new DragControls(dragObjs, camera, viewEl);
let dragStartPos = null;
drag.addEventListener('dragstart', e => {
  state.selected = e.object;
  controls.enabled = false;
  dragStartPos = e.object.position.clone();
  highlightSelection();
});
drag.addEventListener('drag', e => {
  const o = e.object;
  const ud = o.userData;
  // 由 mesh.position 反推 min 角
  const item = { x: o.position.x - ud.l / 2, y: o.position.y - ud.h / 2, z: o.position.z - ud.w / 2, l: ud.l, w: ud.w, h: ud.h };
  // 实时夹紧边界（防止拖出容器）
  const { L, W, H } = state.container;
  item.x = Math.max(0, Math.min(item.x, L - ud.l));
  item.z = Math.max(0, Math.min(item.z, W - ud.w));
  item.y = Math.max(0, Math.min(item.y, H - ud.h));
  o.position.set(item.x + ud.l / 2, item.y + ud.h / 2, item.z + ud.w / 2);
});
drag.addEventListener('dragend', e => {
  controls.enabled = true;
  const o = e.object;
  const ud = o.userData;
  const item = { instanceId: ud.instanceId, baseId: ud.baseId, name: ud.name, color: ud.color,
                 x: o.position.x - ud.l / 2, y: o.position.y - ud.h / 2, z: o.position.z - ud.w / 2,
                 l: ud.l, w: ud.w, h: ud.h };
  if (!validPosition(item, ud.instanceId)) {
    // 回退
    o.position.copy(dragStartPos);
    flash(o, 0xff4d4f);
  } else {
    // 写回 state（同时更新 ud 以便记录朝向变化）
    updatePlacedItem(item);
  }
});
function setDragMode(on) {
  drag.enabled = on;
  dragObjs.length = 0;
  if (on) for (const m of meshByInst.values()) dragObjs.push(m);
}

// ---------- 选中高亮 ----------
function highlightSelection() {
  for (const m of meshByInst.values()) {
    m.material.emissive?.setHex(0x000000);
  }
  if (state.selected) {
    state.selected.material.emissive?.setHex(0x3370ff);
  }
}
function flash(m, color) {
  const orig = m.material.color.clone();
  m.material.color.setHex(color);
  setTimeout(() => m.material.color.copy(orig), 200);
}

// ---------- 点击：选中 + 循环旋转 ----------
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
viewEl.addEventListener('click', e => {
  const rect = viewEl.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects([...meshByInst.values()]);
  if (hits.length) {
    state.selected = hits[0].object;
    highlightSelection();
  } else {
    state.selected = null;
    highlightSelection();
  }
});

// ---------- 渲染循环 ----------
function resize() {
  if (!renderer) return;
  const r = canvas.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  if (renderer) renderer.render(scene, camera);
}
animate();

// ---------- UI 绑定 ----------
const $ = id => document.getElementById(id);

function readCargoRows() {
  const rows = [...$('cargoBody').querySelectorAll('tr')];
  const defs = [];
  rows.forEach((tr, i) => {
    const inputs = tr.querySelectorAll('input');
    const name = (inputs[0].value || '货物' + i).trim();
    const l = +inputs[1].value || 0;
    const w = +inputs[2].value || 0;
    const h = +inputs[3].value || 0;
    const qty = Math.max(1, +inputs[4].value || 1);
    const color = inputs[5].value;
    if (l > 0 && w > 0 && h > 0) defs.push({ id: tr.dataset.id, name, l, w, h, qty, color });
  });
  state.cargoDef = defs;
  return defs;
}

function addCargoRow(def = {}) {
  const tr = document.createElement('tr');
  tr.dataset.id = 'c' + (state.nextId++);
  const colors = ['#ff7d00', '#165dff', '#00b42a', '#f53f3f', '#722ed1', '#eb2f96', '#14c9c9', '#f7ba1e'];
  const c = def.color || colors[Math.floor(Math.random() * colors.length)];
  tr.innerHTML = `
    <td><input type="text" value="${def.name || ''}"></td>
    <td><input type="number" value="${def.l || ''}"></td>
    <td><input type="number" value="${def.w || ''}"></td>
    <td><input type="number" value="${def.h || ''}"></td>
    <td><input type="number" value="${def.qty || 1}" min="1"></td>
    <td><input type="color" value="${c}"></td>
    <td><button class="btn" data-act="del">×</button></td>`;
  tr.querySelector('[data-act=del]').onclick = () => tr.remove();
  $('cargoBody').appendChild(tr);
}

// 默认示例
addCargoRow({ name: '纸箱A', l: 600, w: 400, h: 500, qty: 8 });
addCargoRow({ name: '纸箱B', l: 800, w: 600, h: 300, qty: 5 });
addCargoRow({ name: '小盒', l: 400, w: 300, h: 200, qty: 10 });

$('addCargo').onclick = () => addCargoRow();
$('applyContainer').onclick = () => {
  state.container = { L: +$('cW').value, W: +$('cD').value, H: +$('cH').value };
  buildContainer();
  setDragMode(state.mode === 'manual');
};

$('autoPack').onclick = () => {
  const defs = readCargoRows();
  const packer = new Packer(state.container.L, state.container.W, state.container.H);
  const { placed, unplaced } = packer.packAll(defs);
  state.placed = placed.map(p => ({
    instanceId: p.instanceId, baseId: p.baseId, name: p.name, color: p.color,
    x: p.x, y: p.y, z: p.z, l: p.l, w: p.w, h: p.h
  }));
  state.unplaced = unplaced;
  state.stepIndex = state.placed.length;
  syncMeshesFromPlaced();
  setDragMode(state.mode === 'manual');
  refreshUI();
};

$('clearBox').onclick = () => {
  state.placed = [];
  state.stepIndex = 0;
  for (const m of meshByInst.values()) scene.remove(m);
  meshByInst.clear();
  setDragMode(state.mode === 'manual');
  refreshUI();
};

document.querySelectorAll('input[name=mode]').forEach(r => {
  r.onchange = e => {
    state.mode = e.target.value;
    setDragMode(state.mode === 'manual');
    $('pendingWrap').style.display = state.mode === 'manual' ? '' : 'none';
    refreshUI();
  };
});

// 手动放入一件（从第一件待装箱取）
$('addOneManual').onclick = () => {
  if (state.mode !== 'manual') { alert('请先切换到手动模式'); return; }
  const defs = readCargoRows();
  if (!defs.length) { alert('请先添加货物'); return; }
  // 取一个待装的（用 qty 计数），找空位放
  const def = defs[0];
  const item = {
    instanceId: 'manual-' + (state.nextId++), baseId: def.id, name: def.name, color: def.color,
    x: 0, y: 0, z: 0, l: def.l, w: def.w, h: def.h
  };
  // 尝试放在 (0,0,0)，若冲突则找最低可用位置
  if (!validPosition(item, item.instanceId)) {
    // 简单回退：在容器内扫描找空位
    const step = 50;
    let placedOk = false;
    for (let y = 0; y <= state.container.H - item.h && !placedOk; y += step)
      for (let z = 0; z <= state.container.W - item.w && !placedOk; z += step)
        for (let x = 0; x <= state.container.L - item.l && !placedOk; x += step) {
          const cand = { ...item, x, y, z };
          if (validPosition(cand, cand.instanceId)) { Object.assign(item, cand); placedOk = true; }
        }
    if (!placedOk) { alert('找不到空位放入该货物'); return; }
  }
  state.placed.push(item);
  state.stepIndex = state.placed.length;
  syncMeshesFromPlaced();
  setDragMode(true);
  refreshUI();
};

// 旋转选中货物：循环切换 6 种朝向
$('rotateSel').onclick = () => {
  if (!state.selected) { alert('请先点击选中一件货物'); return; }
  const o = state.selected;
  const ud = o.userData;
  const cur = state.placed.find(p => p.instanceId === ud.instanceId);
  if (!cur) return;
  // 当前 (l,w,h)，生成 6 朝向，找下一个
  const base = { l: cur.l, w: cur.w, h: cur.h };
  const orients = orientationsOf(base);
  let idx = orients.findIndex(o => o.l === cur.l && o.w === cur.w && o.h === cur.h);
  idx = (idx + 1) % orients.length;
  const next = orients[idx];
  // 尝试保持 min 角，但需 fit；不行则微调
  const cand = { ...cur, l: next.l, w: next.w, h: next.h };
  if (!validPosition(cand, cur.instanceId)) {
    // 尝试贴底贴前
    cand.x = 0; cand.z = 0; cand.y = 0;
    if (!validPosition(cand, cur.instanceId)) { alert('旋转后无法放入，请先腾出空间'); return; }
  }
  Object.assign(cur, cand);
  ud.l = cur.l; ud.w = cur.w; ud.h = cur.h;
  // 重建几何
  rebuildMesh(o, cur);
  refreshUI();
};

$('removeSel').onclick = () => {
  if (!state.selected) { alert('请先选中货物'); return; }
  const id = state.selected.userData.instanceId;
  state.placed = state.placed.filter(p => p.instanceId !== id);
  scene.remove(state.selected);
  meshByInst.delete(id);
  state.selected = null;
  setDragMode(state.mode === 'manual');
  refreshUI();
};

function rebuildMesh(m, item) {
  scene.remove(m);
  meshByInst.delete(item.instanceId);
  const nm = makeBoxMesh(item);
  nm.userData.l = item.l; nm.userData.w = item.w; nm.userData.h = item.h;
  scene.add(nm);
  meshByInst.set(item.instanceId, nm);
  state.selected = nm;
  setDragMode(state.mode === 'manual');
}

function updatePlacedItem(item) {
  const p = state.placed.find(x => x.instanceId === item.instanceId);
  if (p) { Object.assign(p, item); }
  refreshUI();
}

// 6 朝向（复用 packer 的 orientations）
function orientationsOf(box) {
  const a = [box.l, box.w, box.h];
  const seen = new Set(); const out = [];
  const perms = (arr) => arr.length === 1 ? [arr] : arr.flatMap((v, i) => perms(arr.slice(0, i).concat(arr.slice(i + 1))).map(t => [v, ...t]));
  for (const p of perms([0, 1, 2])) {
    const key = p.map(i => a[i]).join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ l: a[p[0]], h: a[p[1]], w: a[p[2]] });
  }
  return out;
}

// ---------- 统计 / 待装 / 步骤 ----------
function refreshUI() {
  const { L, W, H } = state.container;
  const volC = L * W * H;
  const used = state.placed.reduce((s, p) => s + p.l * p.w * p.h, 0);
  const rate = volC ? (used / volC * 100).toFixed(1) : 0;
  $('stats').innerHTML = `
    集装箱内尺寸：${L} × ${W} × ${H} mm<br>
    容器容积：${(volC / 1e9).toFixed(2)} m³<br>
    已装箱数：${state.placed.length} 件<br>
    占用体积：${(used / 1e9).toFixed(2)} m³<br>
    空间利用率：<b>${rate}%</b>`;
  // 待装箱
  const defs = state.cargoDef.length ? state.cargoDef : readCargoRows();
  const placedCount = {};
  state.placed.forEach(p => { placedCount[p.baseId] = (placedCount[p.baseId] || 0) + 1; });
  const pend = defs.map(d => ({ ...d, placed: placedCount[d.id] || 0, left: Math.max(0, (d.qty || 1) - (placedCount[d.id] || 0)) })).filter(d => d.left > 0);
  $('pendingList').innerHTML = pend.map(d => `<div class="pend-item" data-id="${d.id}"><span class="pend-swatch" style="background:${d.color}"></span>${d.name} ${d.l}×${d.w}×${d.h} ×${d.left}</div>`).join('');
  $('pendingList').querySelectorAll('.pend-item').forEach(el => {
    el.onclick = () => {
      if (state.mode !== 'manual') { alert('切换到手动模式后可放入'); return; }
      const d = defs.find(x => x.id === el.dataset.id);
      if (!d) return;
      placeOnePending(d);
    };
  });
  // 光标信息
  $('cursorInfo').textContent = `待装箱：${pend.reduce((s, d) => s + d.left, 0)} / 已装箱：${state.placed.length}`;
  // 步骤
  $('stepInfo').textContent = state.placed.length ? `当前显示：${state.stepIndex} / ${state.placed.length} 件` : '无装箱数据';
  applyStepView();
}

function placeOnePending(def) {
  const item = {
    instanceId: 'manual-' + (state.nextId++), baseId: def.id, name: def.name, color: def.color,
    x: 0, y: 0, z: 0, l: def.l, w: def.w, h: def.h
  };
  if (!validPosition(item, item.instanceId)) {
    const step = 50; let ok = false;
    for (let y = 0; y <= state.container.H - item.h && !ok; y += step)
      for (let z = 0; z <= state.container.W - item.w && !ok; z += step)
        for (let x = 0; x <= state.container.L - item.l && !ok; x += step) {
          const c = { ...item, x, y, z };
          if (validPosition(c, c.instanceId)) { Object.assign(item, c); ok = true; }
        }
    if (!ok) { alert('找不到空位'); return; }
  }
  state.placed.push(item);
  state.stepIndex = state.placed.length;
  syncMeshesFromPlaced();
  setDragMode(true);
  refreshUI();
}

// 步骤视图：只显示前 stepIndex 件
function applyStepView() {
  state.placed.forEach((p, i) => {
    const m = meshByInst.get(p.instanceId);
    if (m) m.visible = i < state.stepIndex;
  });
}

$('stepPrev').onclick = () => { state.stepIndex = Math.max(0, state.stepIndex - 1); refreshUI(); };
$('stepNext').onclick = () => { state.stepIndex = Math.min(state.placed.length, state.stepIndex + 1); refreshUI(); };
$('stepReset').onclick = () => { state.stepIndex = state.placed.length; refreshUI(); };

// ---------- 导出 / 导入 ----------
$('exportPlan').onclick = () => {
  const data = {
    container: state.container,
    cargoDef: readCargoRows(),
    placed: state.placed,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = '装箱方案.json'; a.click();
  URL.revokeObjectURL(url);
};

$('importPlan').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      state.container = data.container;
      $('cW').value = data.container.L; $('cD').value = data.container.W; $('cH').value = data.container.H;
      buildContainer();
      // 重建货物表
      $('cargoBody').innerHTML = '';
      (data.cargoDef || []).forEach(d => addCargoRow(d));
      readCargoRows();
      state.placed = data.placed || [];
      state.stepIndex = state.placed.length;
      // 重建 mesh userData dims
      for (const m of meshByInst.values()) scene.remove(m);
      meshByInst.clear();
      syncMeshesFromPlaced();
      for (const m of meshByInst.values()) { const ud = m.userData; const p = state.placed.find(x => x.instanceId === ud.instanceId); if (p) { ud.l = p.l; ud.w = p.w; ud.h = p.h; ud.name = p.name; ud.color = p.color; ud.baseId = p.baseId; } }
      setDragMode(state.mode === 'manual');
      refreshUI();
    } catch (err) { alert('导入失败：' + err.message); }
  };
  r.readAsText(f);
};

// 初始化
readCargoRows();
refreshUI();
$('pendingWrap').style.display = 'none';

// 调试钩子（便于排查，可保留）
window.__boxApp = { state, readCargoRows, refreshUI, Packer, meshByInst };
