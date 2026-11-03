import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parsePCD } from './pcd.js';
import { createSamplePCDs } from './demo.js';

window.__vizErrors = [];
window.addEventListener('error', (e) => window.__vizErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__vizErrors.push(String(e.reason)));

// ---------------------------------------------------------------- helpers
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  const p = props || {};
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k === 'value') e.value = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    e.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const num = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const fmtNum = (v) => String(Number(v.toFixed(5)));

let toastTimer = null;
function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3200);
}

const COLOR_MODE_ID = { original: 0, height: 1, intensity: 2, single: 3, deviation: 4 };
const AXES = {
  '+X': [1, 0, 0], '-X': [-1, 0, 0],
  '+Y': [0, 1, 0], '-Y': [0, -1, 0],
  '+Z': [0, 0, 1], '-Z': [0, 0, -1],
};
const PLANE_COLORS = ['#4ea1ff', '#ffb454', '#3fb950', '#d2a8ff', '#ff7b72', '#56d4dd'];
const ZAXIS = new THREE.Vector3(0, 0, 1);

const state = {
  clouds: [], planes: [], lines: [],
  activePlaneId: null, nextId: 1,
  colorMode: 'deviation', pointSize: 3, sizeMode: 'fixed',
  opacity: 1, singleColor: '#9ecbff',
  clipThickness: 0, devRange: 0.1, fitRadius: 0.15,
  placeMode: 'none', showTicks: true,
  globalBounds: null, heightRange: [0, 1], intensityRange: [0, 1],
};

// ---------------------------------------------------------------- three.js
const canvas = $('gl');
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x0e1116, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 5000);
camera.up.set(0, 0, 1);
camera.position.set(9, -12, 8);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.screenSpacePanning = true;
controls.minDistance = 0.05;
controls.maxDistance = 3000;

const axesHelper = new THREE.AxesHelper(1);
scene.add(axesHelper);
const boxHelper = new THREE.Box3Helper(new THREE.Box3(), 0x3fb950);
boxHelper.visible = false;
scene.add(boxHelper);

const uniforms = {
  uSize: { value: 3 },
  uScale: { value: 600 },
  uSizeMode: { value: 1 },
  uColorMode: { value: 4 },
  uBaseColor: { value: new THREE.Color(0x9ecbff) },
  uHRange: { value: new THREE.Vector2(0, 1) },
  uIRange: { value: new THREE.Vector2(0, 1) },
  uPlaneN: { value: new THREE.Vector3(0, 0, 1) },
  uPlaneC: { value: 0 },
  uDevRange: { value: 0.1 },
  uOutsideAlpha: { value: 0.25 },
  uOpacity: { value: 1 },
  uClipThickness: { value: 0 },
};

const vertexShader = [
  'attribute vec3 aColor;',
  'attribute float aIntensity;',
  'uniform float uSize;',
  'uniform float uScale;',
  'uniform float uSizeMode;',
  'uniform int uColorMode;',
  'uniform vec3 uBaseColor;',
  'uniform vec2 uHRange;',
  'uniform vec2 uIRange;',
  'uniform vec3 uPlaneN;',
  'uniform float uPlaneC;',
  'uniform float uDevRange;',
  'uniform float uOutsideAlpha;',
  'uniform float uOpacity;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'varying float vDist;',
  'vec3 heat(float t) {',
  '  t = clamp(t, 0.0, 1.0);',
  '  vec3 a = vec3(0.10, 0.05, 0.45);',
  '  vec3 b = vec3(0.00, 0.75, 1.00);',
  '  vec3 c = vec3(0.05, 0.90, 0.25);',
  '  vec3 d = vec3(1.00, 0.88, 0.00);',
  '  vec3 e = vec3(1.00, 0.12, 0.08);',
  '  if (t < 0.25) return mix(a, b, t / 0.25);',
  '  if (t < 0.50) return mix(b, c, (t - 0.25) / 0.25);',
  '  if (t < 0.75) return mix(c, d, (t - 0.50) / 0.25);',
  '  return mix(d, e, (t - 0.75) / 0.25);',
  '}',
  'vec3 devRamp(float t) {',
  '  t = clamp(t, 0.0, 1.0);',
  '  vec3 c0 = vec3(0.18, 0.28, 0.74);',
  '  vec3 c1 = vec3(0.12, 0.66, 0.80);',
  '  vec3 c2 = vec3(0.28, 0.78, 0.38);',
  '  vec3 c3 = vec3(0.94, 0.72, 0.20);',
  '  vec3 c4 = vec3(0.78, 0.32, 0.28);',
  '  if (t < 0.25) return mix(c0, c1, t / 0.25);',
  '  if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);',
  '  if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);',
  '  return mix(c3, c4, (t - 0.75) / 0.25);',
  '}',
  'void main() {',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '  float depth = max(-mv.z, 0.001);',
  '  float px = uSizeMode > 0.5 ? uSize : uSize * uScale / depth;',
  '  gl_PointSize = clamp(px, 1.0, 48.0);',
  '  gl_Position = projectionMatrix * mv;',
  '  float d = dot(position, uPlaneN) + uPlaneC;',
  '  vDist = d;',
  '  float hgt = (position.z - uHRange.x) / max(uHRange.y - uHRange.x, 1e-6);',
  '  float ity = (aIntensity - uIRange.x) / max(uIRange.y - uIRange.x, 1e-6);',
  '  vec3 col = aColor;',
  '  float a = uOpacity;',
  '  if (uColorMode == 1) col = heat(hgt);',
  '  else if (uColorMode == 2) col = heat(ity);',
  '  else if (uColorMode == 3) col = uBaseColor;',
  '  else if (uColorMode == 4) {',
  '    float t = d / max(uDevRange, 1e-6);',
  '    if (abs(t) > 1.0) {',
  '      col = vec3(0.30, 0.33, 0.38);',
  '      a = uOpacity * uOutsideAlpha;',
  '    } else {',
  '      col = devRamp(0.5 + 0.5 * t);',
  '    }',
  '  }',
  '  vColor = col;',
  '  vAlpha = a;',
  '}',
].join('\n');

const fragmentShader = [
  'uniform float uClipThickness;',
  'varying vec3 vColor;',
  'varying float vAlpha;',
  'varying float vDist;',
  'void main() {',
  '  vec2 p = gl_PointCoord * 2.0 - 1.0;',
  '  float r2 = dot(p, p);',
  '  if (r2 > 1.0) discard;',
  '  if (uClipThickness > 0.0 && abs(vDist) > uClipThickness) discard;',
  '  float a = vAlpha * (1.0 - 0.35 * smoothstep(0.55, 1.0, r2));',
  '  gl_FragColor = vec4(vColor, a);',
  '}',
].join('\n');

const pointMat = new THREE.ShaderMaterial({
  uniforms, vertexShader, fragmentShader,
  transparent: true, depthTest: true, depthWrite: true,
});

// ---------------------------------------------------------------- bounds helpers
function boundsCenter() {
  const b = state.globalBounds;
  return b ? new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2) : new THREE.Vector3();
}
function boundsSpan() {
  const b = state.globalBounds;
  return b ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1) : 10;
}
function axisIndex(v) {
  const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  return a[0] >= a[1] && a[0] >= a[2] ? 0 : (a[1] >= a[2] ? 1 : 2);
}

// ---------------------------------------------------------------- point clouds
function constantColors(n) {
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = 0.72; a[i * 3 + 1] = 0.79; a[i * 3 + 2] = 0.88; }
  return a;
}
function heightAsIntensity(pos) {
  const a = new Float32Array(pos.length / 3);
  for (let i = 0; i < a.length; i++) a[i] = pos[i * 3 + 2];
  return a;
}

function addCloudFromBuffer(name, buffer) {
  const parsed = parsePCD(buffer);
  if (!parsed.count) throw new Error('文件中没有有效点');
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(parsed.positions, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(parsed.colors || constantColors(parsed.count), 3));
  geo.setAttribute('aIntensity', new THREE.BufferAttribute(parsed.intensity || heightAsIntensity(parsed.positions), 1));
  geo.computeBoundingSphere();
  const obj = new THREE.Points(geo, pointMat);
  scene.add(obj);
  const cloud = {
    id: state.nextId++, name, count: parsed.count, encoding: parsed.encoding,
    bounds: parsed.bounds, hasRGB: !!parsed.colors, object: obj, visible: true,
  };
  const first = state.clouds.length === 0;
  state.clouds.push(cloud);
  refreshGlobalStats(first);
  renderFileList();
  return cloud;
}

function refreshGlobalStats(firstLoad) {
  const cs = state.clouds;
  if (!cs.length) {
    state.globalBounds = null;
    state.heightRange = [0, 1];
    state.intensityRange = [0, 1];
  } else {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let iMin = Infinity, iMax = -Infinity;
    for (const c of cs) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], c.bounds.min[k]);
        max[k] = Math.max(max[k], c.bounds.max[k]);
      }
      const ia = c.object.geometry.getAttribute('aIntensity');
      for (let i = 0; i < ia.count; i++) {
        const v = ia.array[i];
        if (Number.isFinite(v)) { if (v < iMin) iMin = v; if (v > iMax) iMax = v; }
      }
    }
    state.globalBounds = { min, max };
    state.heightRange = [min[2], max[2]];
    state.intensityRange = iMax > iMin ? [iMin, iMax] : [iMin - 1, iMax + 1];
  }
  uniforms.uHRange.value.set(state.heightRange[0], state.heightRange[1]);
  uniforms.uIRange.value.set(state.intensityRange[0], state.intensityRange[1]);

  const span = boundsSpan();
  axesHelper.scale.setScalar(span * 0.28);
  if (state.globalBounds) {
    boxHelper.box.set(
      new THREE.Vector3(state.globalBounds.min[0], state.globalBounds.min[1], state.globalBounds.min[2]),
      new THREE.Vector3(state.globalBounds.max[0], state.globalBounds.max[1], state.globalBounds.max[2]),
    );
  }

  for (const p of state.planes) {
    updatePlaneRanges(p);
    if (firstLoad) autoPlacePlane(p);
    buildPlaneGrid(p);
    syncPlaneUI(p);
  }
  if (firstLoad && cs.length) fitView();
  updateLegend();
  updateReport();
  updateHUD();
}

function renderFileList() {
  const box = $('file-list');
  box.textContent = '';
  if (!state.clouds.length) {
    box.appendChild(h('div', { class: 'empty', text: '尚未载入点云。可拖放 .pcd 文件到右侧视图。' }));
    return;
  }
  for (const c of state.clouds) {
    const vis = h('input', { type: 'checkbox', checked: c.visible });
    vis.addEventListener('change', () => { c.visible = vis.checked; c.object.visible = vis.checked; updateReport(); updateHUD(); });
    const del = h('button', { class: 'mini-x', title: '移除', text: '✕' });
    del.addEventListener('click', () => removeCloud(c));
    box.appendChild(h('div', { class: 'file-item' },
      vis,
      h('span', { class: 'name', text: c.name, title: c.name }),
      h('span', { class: 'meta', text: (c.count / 1000).toFixed(1) + 'k · ' + c.encoding }),
      del));
  }
}

function removeCloud(c) {
  scene.remove(c.object);
  c.object.geometry.dispose();
  state.clouds = state.clouds.filter((x) => x !== c);
  refreshGlobalStats(false);
  renderFileList();
}

function clearClouds() {
  for (const c of state.clouds) { scene.remove(c.object); c.object.geometry.dispose(); }
  state.clouds = [];
  refreshGlobalStats(false);
  renderFileList();
  toast('已清空点云');
}

// ---------------------------------------------------------------- camera views
function setView(name) {
  const c = boundsCenter();
  const r = Math.max(boundsSpan() * 1.15, 1);
  const d = r * 2.1;
  let off;
  if (name === 'top') off = new THREE.Vector3(0.001, -0.002, 1).normalize().multiplyScalar(d * 1.5);
  else if (name === 'front') off = new THREE.Vector3(0, -1, 0.18).normalize().multiplyScalar(d);
  else if (name === 'side') off = new THREE.Vector3(-1, 0, 0.18).normalize().multiplyScalar(d);
  else off = new THREE.Vector3(0.9, -1.1, 0.8).normalize().multiplyScalar(d);
  controls.target.copy(c);
  camera.position.copy(c).add(off);
  camera.up.set(0, 0, 1);
  camera.lookAt(c);
  controls.update();
}
function fitView() { setView('iso'); }

// ---------------------------------------------------------------- auxiliary planes
function autoSpacing(size) {
  const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
  for (const s of steps) if (size / s <= 22) return s;
  return 200;
}
function effectiveSpacing(p) { return p.spacing > 0 ? p.spacing : autoSpacing(p.size); }

function updatePlaneRanges(p) {
  const b = state.globalBounds;
  if (!b || !p.ui.offset) return;
  const n0 = p.baseNormal;
  const i = axisIndex(n0);
  const span = Math.max(b.max[i] - b.min[i], 1);
  const a = n0.getComponent(i) * (b.min[i] - span * 0.3);
  const c = n0.getComponent(i) * (b.max[i] + span * 0.3);
  p.ui.offset.setRange(Math.min(a, c), Math.max(a, c), (Math.abs(c - a)) / 2000);
  p.ui.size.setRange(1, span * 4, span / 200);
}

function autoPlacePlane(p) {
  const b = state.globalBounds;
  if (!b) return;
  const c = boundsCenter();
  switch (p.axis) {
    case '+Z': c.z = b.min[2]; break;
    case '-Z': c.z = b.max[2]; break;
    case '+Y': c.y = b.max[1]; break;
    case '-Y': c.y = b.min[1]; break;
    case '+X': c.x = b.max[0]; break;
    case '-X': c.x = b.min[0]; break;
  }
  p.dist = p.baseNormal.dot(c);
  p.tiltX = 0; p.tiltY = 0;
  p.size = Math.max(boundsSpan() * 1.5, 2);
  updatePlaneTransform(p);
}

function updatePlaneTransform(p) {
  const qTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.tiltX * RAD, p.tiltY * RAD, 0, 'XYZ'));
  const q = p.qBase.clone().multiply(qTilt);
  p.group.quaternion.copy(q);
  p.normal.copy(ZAXIS).applyQuaternion(q).normalize();
  p.group.position.copy(p.normal).multiplyScalar(p.dist);
  p.normalArrow.setDirection(ZAXIS);
  p.normalArrow.setLength(Math.min(p.size * 0.22, 2), Math.min(p.size * 0.07, 0.6), Math.min(p.size * 0.03, 0.3));
}

function buildPlaneGrid(p) {
  const g = p.gridGroup;
  for (const child of g.children.slice()) { g.remove(child); child.geometry.dispose(); child.material.dispose(); }
  const half = p.size / 2;
  const sp = effectiveSpacing(p);
  const n = Math.floor(half / sp);
  const minor = [], major = [], center = [];
  const z = 0.006;
  for (let k = -n; k <= n; k++) {
    const v = k * sp;
    if (Math.abs(v) > half + 1e-6) continue;
    const target = (k !== 0 && k % 5 === 0) ? major : (k === 0 ? center : minor);
    target.push(-half, v, z, half, v, z);
    target.push(v, -half, z, v, half, z);
  }
  const base = new THREE.Color(p.color);
  const mk = (arr, col, opacity) => {
    if (!arr.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    const mat = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity, depthWrite: false });
    const seg = new THREE.LineSegments(geo, mat);
    seg.renderOrder = 2;
    g.add(seg);
  };
  mk(minor, base.clone().multiplyScalar(0.55), 0.5);
  mk(major, base.clone().multiplyScalar(0.9), 0.85);
  mk(center, new THREE.Color(0xffffff), 0.95);

  // Border
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute([
    -half, -half, z, half, -half, z, half, half, z, -half, half, z,
  ], 3));
  const loop = new THREE.LineLoop(bg, new THREE.LineBasicMaterial({ color: p.color, transparent: true, opacity: 0.95, depthWrite: false }));
  loop.renderOrder = 2;
  g.add(loop);
}

function updatePlaneVisual(p) {
  p.mesh.material.color.set(p.color);
  p.mesh.material.opacity = p.opacity;
  p.mesh.scale.set(p.size, p.size, 1);
  p.normalArrow.setColor(new THREE.Color(p.color));
  buildPlaneGrid(p);
  updatePlaneTransform(p);
}

function makePlane(name, axis, color) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.renderOrder = 1;
  const gridGroup = new THREE.Group();
  const normalArrow = new THREE.ArrowHelper(ZAXIS.clone(), new THREE.Vector3(), 1, color, 0.3, 0.15);
  group.add(mesh, gridGroup, normalArrow);
  scene.add(group);
  const p = {
    id: state.nextId++, name, axis, color,
    tiltX: 0, tiltY: 0, dist: 0, size: 10, spacing: 0, opacity: 0.12,
    visible: true, group, mesh, gridGroup, normalArrow,
    baseNormal: new THREE.Vector3(), qBase: new THREE.Quaternion(),
    normal: new THREE.Vector3(0, 0, 1), ui: {},
  };
  setPlaneAxis(p, axis, false);
  buildPlaneCard(p);
  updatePlaneVisual(p);
  state.planes.push(p);
  return p;
}

function setPlaneAxis(p, axis, doAutoPlace) {
  p.axis = axis;
  p.baseNormal.set(AXES[axis][0], AXES[axis][1], AXES[axis][2]);
  p.qBase.setFromUnitVectors(ZAXIS, p.baseNormal.clone());
  p.normal.copy(p.baseNormal);
  if (doAutoPlace) autoPlacePlane(p);
  updatePlaneTransform(p);
}

function removePlane(p) {
  scene.remove(p.group);
  p.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  state.planes = state.planes.filter((x) => x !== p);
  if (state.activePlaneId === p.id) state.activePlaneId = state.planes.length ? state.planes[0].id : null;
  p.card.remove();
  refreshActivePlaneSelect();
  syncActivePlaneUniforms();
  updateReport();
}

function addSlider(body, p, key, label, min, max, step, onChange) {
  const range = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(p[key]) });
  const numberInput = h('input', { type: 'number', step: String(step), class: 'num-mini', value: String(p[key]) });
  body.appendChild(h('label', { class: 'row' }, h('span', { text: label }), range, numberInput));
  const apply = (raw) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    p[key] = v;
    numberInput.value = fmtNum(v);
    range.value = String(clamp(v, min, max));
    onChange();
  };
  range.addEventListener('input', () => apply(range.value));
  numberInput.addEventListener('change', () => apply(numberInput.value));
  p.ui[key] = {
    range, num: numberInput, min, max,
    set(v) { numberInput.value = fmtNum(v); range.value = String(clamp(v, this.min, this.max)); },
    setRange(a, b, s) { this.min = a; this.max = b; range.min = String(a); range.max = String(b); range.step = String(s); this.set(p[key]); },
  };
}

function buildPlaneCard(p) {
  const vis = h('input', { type: 'checkbox', checked: true, title: '显示' });
  vis.addEventListener('change', () => { p.visible = vis.checked; p.group.visible = vis.checked; });
  const del = h('button', { class: 'mini-x', title: '删除该平面', text: '✕' });
  del.addEventListener('click', () => removePlane(p));
  const head = h('div', { class: 'plane-head' },
    h('span', { class: 'dot', style: 'background:' + p.color }),
    h('span', { class: 'name', text: p.name }), vis, del);
  const body = h('div', { class: 'plane-body' });

  const axisSel = h('select');
  for (const a of Object.keys(AXES)) axisSel.appendChild(h('option', { value: a, text: a + ' 法向' }));
  axisSel.value = p.axis;
  axisSel.addEventListener('change', () => {
    setPlaneAxis(p, axisSel.value, true);
    syncPlaneUI(p);
    updatePlaneVisual(p);
    onPlaneTransformChanged();
  });
  body.appendChild(h('label', { class: 'row' }, h('span', { text: '基准方向' }), axisSel));
  p.ui.axis = axisSel;

  const onTransform = () => { updatePlaneTransform(p); onPlaneTransformChanged(); };
  const onVisual = () => { updatePlaneVisual(p); onPlaneTransformChanged(); };
  addSlider(body, p, 'dist', '偏移', -20, 20, 0.005, onTransform);
  addSlider(body, p, 'tiltX', '倾角 X°', -89, 89, 0.05, onTransform);
  addSlider(body, p, 'tiltY', '倾角 Y°', -89, 89, 0.05, onTransform);

  const spacingSel = h('select');
  spacingSel.appendChild(h('option', { value: '0', text: '自动' }));
  for (const s of [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20]) spacingSel.appendChild(h('option', { value: String(s), text: String(s) + ' m' }));
  spacingSel.addEventListener('change', () => { p.spacing = Number(spacingSel.value); updatePlaneVisual(p); });
  body.appendChild(h('label', { class: 'row' }, h('span', { text: '网格间距' }), spacingSel));
  p.ui.spacing = spacingSel;

  addSlider(body, p, 'size', '网格范围', 1, 100, 0.5, onVisual);
  addSlider(body, p, 'opacity', '面透明度', 0, 0.9, 0.01, onVisual);
  const colorInput = h('input', { type: 'color', value: p.color });
  colorInput.addEventListener('input', () => { p.color = colorInput.value; head.querySelector('.dot').style.background = p.color; updatePlaneVisual(p); });
  body.appendChild(h('label', { class: 'row' }, h('span', { text: '颜色' }), colorInput));
  p.ui.color = colorInput;

  const bFit = h('button', { text: '拟合附近点' });
  bFit.addEventListener('click', () => fitNearby(p));
  const bRansac = h('button', { text: '自动找主平面' });
  bRansac.addEventListener('click', () => ransacPlane());
  const bZero = h('button', { text: '倾角归零' });
  bZero.addEventListener('click', () => {
    p.tiltX = 0; p.tiltY = 0; syncPlaneUI(p); updatePlaneTransform(p); onPlaneTransformChanged();
  });
  body.appendChild(h('div', { class: 'btn-row wrap' }, bFit, bRansac, bZero));

  const readout = h('div', { class: 'readout' });
  body.appendChild(readout);
  p.ui.readout = readout;

  p.card = h('div', { class: 'plane-card' }, head, body);
  $('plane-list').appendChild(p.card);
}

function syncPlaneUI(p) {
  if (!p.ui.axis) return;
  p.ui.axis.value = p.axis;
  for (const key of ['dist', 'tiltX', 'tiltY', 'size', 'opacity']) if (p.ui[key]) p.ui[key].set(p[key]);
  p.ui.spacing.value = String(p.spacing);
  p.ui.color.value = p.color;
  updatePlaneReadout(p);
}

function angleToBase(p) {
  return Math.acos(clamp(Math.abs(p.normal.dot(p.baseNormal)), 0, 1)) * DEG;
}

function planeEquation(p) {
  const n = p.normal;
  return num(n.x, 4) + 'x ' + (n.y < 0 ? '- ' : '+ ') + num(Math.abs(n.y), 4) + 'y ' +
    (n.z < 0 ? '- ' : '+ ') + num(Math.abs(n.z), 4) + 'z = ' + num(p.dist, 4);
}

function updatePlaneReadout(p) {
  const el = p.ui.readout;
  if (!el) return;
  el.textContent = '';
  const a = angleToBase(p);
  const cls = a < 0.3 ? 'ok' : (a > 1 ? 'warn' : '');
  el.appendChild(h('div', { text: '法向 (' + num(p.normal.x, 4) + ', ' + num(p.normal.y, 4) + ', ' + num(p.normal.z, 4) + ')' }));
  el.appendChild(h('div', { text: planeEquation(p) }));
  el.appendChild(h('div', {}, h('span', { class: 'k', text: '偏离基准 ' }), h('span', { class: cls, text: num(a, 3) + '°' })));
}

function activePlane() {
  return state.planes.find((p) => p.id === state.activePlaneId) || null;
}

function onPlaneTransformChanged() {
  for (const p of state.planes) updatePlaneReadout(p);
  syncActivePlaneUniforms();
  updateReport();
  updateHUD();
}

function syncActivePlaneUniforms() {
  const p = activePlane();
  if (p) { uniforms.uPlaneN.value.copy(p.normal); uniforms.uPlaneC.value = -p.dist; }
  else { uniforms.uPlaneN.value.set(0, 0, 1); uniforms.uPlaneC.value = 0; }
}

function refreshActivePlaneSelect() {
  const sel = $('active-plane');
  sel.textContent = '';
  sel.appendChild(h('option', { value: 'none', text: '（无）' }));
  for (const p of state.planes) sel.appendChild(h('option', { value: String(p.id), text: p.name }));
  sel.value = state.activePlaneId == null ? 'none' : String(state.activePlaneId);
}

// ---------------------------------------------------------------- plane fitting
function collectPoints(cloudFilter, predicate, limit) {
  const out = [];
  for (const c of state.clouds) {
    if (!c.visible || (cloudFilter && !cloudFilter(c))) continue;
    const pos = c.object.geometry.getAttribute('position').array;
    for (let i = 0; i < pos.length; i += 3) {
      if (predicate(pos[i], pos[i + 1], pos[i + 2])) {
        out.push(pos[i], pos[i + 1], pos[i + 2]);
        if (limit && out.length / 3 >= limit) return Float32Array.from(out);
      }
    }
  }
  return Float32Array.from(out);
}

function solve2(a11, a12, b1, a21, a22, b2) {
  const det = a11 * a22 - a12 * a21;
  if (Math.abs(det) < 1e-14) return null;
  return [(b1 * a22 - b2 * a12) / det, (a11 * b2 - a21 * b1) / det];
}

/** Least-squares plane through points; tries each axis as the dependent one. */
function fitPlane(pts) {
  const n = pts.length / 3;
  if (n < 3) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < pts.length; i += 3) { cx += pts[i]; cy += pts[i + 1]; cz += pts[i + 2]; }
  cx /= n; cy /= n; cz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i] - cx, y = pts[i + 1] - cy, z = pts[i + 2] - cz;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  let best = null;
  // z = A x + B y  ->  normal (A, B, -1)
  let s = solve2(xx, xy, xz, xy, yy, yz);
  if (s) {
    const r = zz - (s[0] * xz + s[1] * yz);
    best = { residual: r, normal: new THREE.Vector3(s[0], s[1], -1) };
  }
  // x = A y + B z  ->  normal (-1, A, B)
  s = solve2(yy, yz, xy, yz, zz, xz);
  if (s) {
    const r = xx - (s[0] * xy + s[1] * xz);
    if (!best || r < best.residual) best = { residual: r, normal: new THREE.Vector3(-1, s[0], s[1]) };
  }
  // y = A x + B z  ->  normal (A, -1, B)
  s = solve2(xx, xz, xy, xz, zz, yz);
  if (s) {
    const r = yy - (s[0] * xy + s[1] * yz);
    if (!best || r < best.residual) best = { residual: r, normal: new THREE.Vector3(s[0], -1, s[1]) };
  }
  if (!best) return null;
  return {
    normal: best.normal.normalize(),
    center: new THREE.Vector3(cx, cy, cz),
    residual: Math.max(best.residual, 0) / n,
  };
}

function refinePlane(points, initial, threshold) {
  let normal = initial.normal.clone();
  let center = initial.center.clone();
  for (let iter = 0; iter < 3; iter++) {
    const c0 = -normal.dot(center);
    const inliers = [];
    for (let i = 0; i < points.length; i += 3) {
      const d = normal.x * points[i] + normal.y * points[i + 1] + normal.z * points[i + 2] + c0;
      if (Math.abs(d) <= threshold) inliers.push(points[i], points[i + 1], points[i + 2]);
    }
    if (inliers.length < 9) break;
    const f = fitPlane(Float32Array.from(inliers));
    if (!f) break;
    if (f.normal.dot(normal) < 0) f.normal.negate();
    normal = f.normal;
    center = f.center;
  }
  return { normal: normal.normalize(), center };
}

function applyFit(p, normal, center) {
  if (normal.dot(p.baseNormal) < 0) normal.negate();
  const t = normal.clone().applyQuaternion(p.qBase.clone().invert());
  const b = Math.atan2(t.x, Math.hypot(t.y, t.z));
  const a = Math.atan2(-t.y, t.z);
  p.tiltX = a * DEG;
  p.tiltY = b * DEG;
  p.dist = normal.dot(center);
  syncPlaneUI(p);
  updatePlaneTransform(p);
  onPlaneTransformChanged();
  toast(p.name + ' 已拟合，偏离基准 ' + num(angleToBase(p), 3) + '°');
}

function fitNearby(p) {
  if (!state.clouds.length) { toast('请先载入点云', true); return; }
  const r = state.fitRadius;
  const n = p.normal.clone(), c0 = -p.dist;
  const pts = collectPoints(null, (x, y, z) => Math.abs(n.x * x + n.y * y + n.z * z + c0) <= r);
  if (pts.length / 3 < 20) { toast('附近点太少，请先把平面移到目标表面附近，或增大拟合半径', true); return; }
  const f = fitPlane(pts);
  if (!f) { toast('拟合失败：点分布退化', true); return; }
  const refined = refinePlane(pts, f, Math.max(r * 0.5, 0.01));
  applyFit(p, refined.normal, refined.center);
}

function collectSample(maxPoints) {
  let total = 0;
  for (const c of state.clouds) if (c.visible) total += c.count;
  const step = Math.max(1, Math.ceil(total / maxPoints));
  const out = [];
  let idx = 0;
  for (const c of state.clouds) {
    if (!c.visible) continue;
    const pos = c.object.geometry.getAttribute('position').array;
    for (let i = 0; i < pos.length; i += 3) {
      if (idx % step === 0) out.push(pos[i], pos[i + 1], pos[i + 2]);
      idx++;
    }
  }
  return Float32Array.from(out);
}

let ransacSeed = 1234567;
function rnd() { ransacSeed = (Math.imul(ransacSeed, 1664525) + 1013904223) >>> 0; return ransacSeed / 4294967296; }

function ransacPlane() {
  if (!state.clouds.length) { toast('请先载入点云', true); return; }
  const sample = collectSample(20000);
  const m = sample.length / 3;
  if (m < 3) { toast('点数不足', true); return; }
  const th = state.fitRadius;
  let best = { count: -1, normal: null, d: 0 };
  const p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), p3 = new THREE.Vector3();
  for (let iter = 0; iter < 160; iter++) {
    const i1 = Math.floor(rnd() * m), i2 = Math.floor(rnd() * m), i3 = Math.floor(rnd() * m);
    if (i1 === i2 || i2 === i3 || i1 === i3) continue;
    p1.fromArray(sample, i1 * 3); p2.fromArray(sample, i2 * 3); p3.fromArray(sample, i3 * 3);
    const n = new THREE.Vector3().subVectors(p2, p1).cross(new THREE.Vector3().subVectors(p3, p1));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    const d = -n.dot(p1);
    let count = 0;
    for (let i = 0; i < sample.length; i += 3) {
      if (Math.abs(n.x * sample[i] + n.y * sample[i + 1] + n.z * sample[i + 2] + d) <= th) count++;
    }
    if (count > best.count) best = { count, normal: n, d };
  }
  if (!best.normal) { toast('未检测到平面', true); return; }
  const near = collectPoints(null, (x, y, z) => Math.abs(best.normal.x * x + best.normal.y * y + best.normal.z * z + best.d) <= th);
  const f = fitPlane(near);
  if (!f) { toast('拟合失败', true); return; }
  const refined = refinePlane(near, f, th * 0.6);
  // Apply to the plane whose base direction best matches the detected normal.
  let target = null, bestDot = -1;
  for (const p of state.planes) {
    const v = Math.abs(p.baseNormal.dot(refined.normal));
    if (v > bestDot) { bestDot = v; target = p; }
  }
  if (!target) {
    target = makePlane('辅助面 ' + (state.planes.length + 1), '+Z', PLANE_COLORS[state.planes.length % PLANE_COLORS.length]);
    updatePlaneRanges(target);
    target.size = Math.max(boundsSpan() * 1.5, 2);
    syncPlaneUI(target);
    updatePlaneVisual(target);
  }
  state.activePlaneId = target.id;
  refreshActivePlaneSelect();
  applyFit(target, refined.normal, refined.center);
  toast('检测到主平面（' + near.length / 3 + ' 个内点），已应用到 ' + target.name);
}

// ---------------------------------------------------------------- guide lines
function lineLabel(o) {
  const names = { x: '沿 X', y: '沿 Y', z: '沿 Z', cross: '十字线' };
  return names[o.dir] + ' @ (' + num(o.point[0], 2) + ', ' + num(o.point[1], 2) + ', ' + num(o.point[2], 2) + ')';
}
function defaultLineLength() { return Math.max(boundsSpan() * 0.9, 2); }
function activeSpacing() { const p = activePlane(); return p ? effectiveSpacing(p) : 1; }

function buildGuideGeometry(group, o, showTicks) {
  for (const child of group.children.slice()) { group.remove(child); child.geometry.dispose(); child.material.dispose(); }
  const L = o.length;
  const axes = [
    { v: [1, 0, 0], c: 0xff6b6b }, { v: [0, 1, 0], c: 0x69f58e }, { v: [0, 0, 1], c: 0x6bb6ff },
  ];
  const col = new THREE.Color(o.color);
  // Explicit direction lookup (kept simple to avoid clever indexing).
  const picked = o.dir === 'x' ? axes[0] : o.dir === 'y' ? axes[1] : axes[2];
  const isCross = o.dir === 'cross';
  const list = isCross ? axes : [{ v: picked.v, c: col }];

  for (const a of list) {
    const v = new THREE.Vector3(a.v[0], a.v[1], a.v[2]);
    const p0 = new THREE.Vector3(o.point[0], o.point[1], o.point[2]).addScaledVector(v, -L / 2);
    const p1 = new THREE.Vector3(o.point[0], o.point[1], o.point[2]).addScaledVector(v, L / 2);
    const geo = new THREE.BufferGeometry().setFromPoints([p0, p1]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: a.c, transparent: true, opacity: 0.95, depthTest: false }));
    line.renderOrder = 10;
    group.add(line);
  }
  if (isCross) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(Math.min(L * 0.012, 0.06), 10, 8), new THREE.MeshBasicMaterial({ color: o.color, depthTest: false }));
    dot.position.set(o.point[0], o.point[1], o.point[2]);
    dot.renderOrder = 10;
    group.add(dot);
  }
  if (showTicks && o.dir !== 'cross') {
    const sp = activeSpacing();
    const v = new THREE.Vector3(list[0].v[0], list[0].v[1], list[0].v[2]);
    const perp = o.dir === 'z' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const arr = [];
    const n = Math.floor(L / 2 / sp);
    for (let k = -n; k <= n; k++) {
      if (k === 0) continue;
      const c = new THREE.Vector3(o.point[0], o.point[1], o.point[2]).addScaledVector(v, k * sp);
      const len = (k % 5 === 0 ? 0.34 : 0.18) * sp;
      arr.push(c.clone().addScaledVector(perp, -len), c.clone().addScaledVector(perp, len));
    }
    if (arr.length) {
      const geo = new THREE.BufferGeometry().setFromPoints(arr);
      const ticks = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x8b98a8, transparent: true, opacity: 0.75, depthTest: false }));
      ticks.renderOrder = 10;
      group.add(ticks);
    }
  }
}

function addGuideLine(o) {
  const opts = Object.assign({ color: '#ffd166', length: defaultLineLength(), point: [0, 0, 0] }, o);
  const group = new THREE.Group();
  scene.add(group);
  const line = Object.assign({ id: state.nextId++, visible: true, group }, opts);
  buildGuideGeometry(group, line, state.showTicks);
  state.lines.push(line);
  renderLineList();
  return line;
}

function renderLineList() {
  const box = $('line-list');
  box.textContent = '';
  if (!state.lines.length) { box.appendChild(h('div', { class: 'empty', text: '暂无辅助线' })); return; }
  for (const l of state.lines) {
    const vis = h('input', { type: 'checkbox', checked: l.visible, title: '显示' });
    vis.addEventListener('change', () => { l.visible = vis.checked; l.group.visible = vis.checked; });
    const del = h('button', { class: 'mini-x', text: '✕', title: '删除' });
    del.addEventListener('click', () => {
      scene.remove(l.group);
      l.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      state.lines = state.lines.filter((x) => x !== l);
      renderLineList();
    });
    box.appendChild(h('div', { class: 'line-item' },
      h('span', { class: 'swatch', style: 'background:' + l.color }),
      h('span', { class: 'name', text: lineLabel(l) }), vis, del));
  }
}

function clearLines() {
  for (const l of state.lines) {
    scene.remove(l.group);
    l.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  }
  state.lines = [];
  renderLineList();
}

// ---------------------------------------------------------------- analysis
function computeStats(p) {
  const n = p.normal, c0 = -p.dist;
  const r = Math.max(state.fitRadius, state.clipThickness);
  let count = 0, sum = 0, ss = 0, min = Infinity, max = -Infinity, w1 = 0, w2 = 0, total = 0;
  for (const c of state.clouds) {
    if (!c.visible) continue;
    const pos = c.object.geometry.getAttribute('position').array;
    total += pos.length / 3;
    for (let i = 0; i < pos.length; i += 3) {
      const d = n.x * pos[i] + n.y * pos[i + 1] + n.z * pos[i + 2] + c0;
      if (Math.abs(d) > r) continue;
      count++; sum += d; ss += d * d;
      if (d < min) min = d;
      if (d > max) max = d;
      if (Math.abs(d) <= 0.01) w1++;
      if (Math.abs(d) <= 0.02) w2++;
    }
  }
  return {
    count, total, mean: count ? sum / count : 0, rms: count ? Math.sqrt(ss / count) : 0,
    min: count ? min : 0, max: count ? max : 0,
    w1: count ? w1 / count * 100 : 0, w2: count ? w2 / count * 100 : 0,
  };
}

function reportLine(box, label, value, cls) {
  box.appendChild(h('div', {},
    h('span', { class: 'k', text: label }),
    h('span', { class: cls || '', text: value })));
}

function updateReport() {
  const box = $('analysis-report');
  box.textContent = '';
  const p = activePlane();
  if (!state.clouds.length) { box.appendChild(h('div', { text: '载入点云后显示。' })); return; }
  if (!p) { box.appendChild(h('div', { text: '请选择一个分析平面。' })); return; }
  const s = computeStats(p);
  const a = angleToBase(p);
  const acls = a < 0.3 ? 'good' : (a > 1 ? 'bad' : '');
  reportLine(box, '分析平面  ', p.name);
  reportLine(box, '基准方向  ', p.axis + '（' + (axisIndex(p.baseNormal) === 2 ? '水平面' : '竖直面') + '）');
  reportLine(box, '平面方程  ', planeEquation(p));
  const big = h('div', { class: 'big', text: '偏离理想方向 ' + num(a, 3) + '°' });
  big.className = 'big ' + acls;
  box.appendChild(big);
  reportLine(box, '参与点数  ', s.count.toLocaleString() + ' / ' + s.total.toLocaleString() + '（半径 ' + num(Math.max(state.fitRadius, state.clipThickness), 3) + ' m）');
  reportLine(box, '均值偏差  ', num(s.mean, 4) + ' m');
  reportLine(box, 'RMS       ', num(s.rms, 4) + ' m', s.rms < 0.01 ? 'good' : '');
  reportLine(box, '最大偏差  ', num(Math.max(Math.abs(s.min), Math.abs(s.max)), 4) + ' m');
  reportLine(box, '|d|≤1cm   ', num(s.w1, 1) + '%', s.w1 > 90 ? 'good' : '');
  reportLine(box, '|d|≤2cm   ', num(s.w2, 1) + '%');
  const verdict = a < 0.3 && s.rms < 0.01 ? '结论：该面基本横平竖直' : (a > 1 ? '结论：倾斜明显，需检查标定 / 安装' : '结论：存在轻微倾斜');
  box.appendChild(h('div', { style: 'margin-top:6px', class: a > 1 ? 'bad' : 'good', text: verdict }));
  for (const q of state.planes) updatePlaneReadout(q);
}

function exportReport() {
  const p = activePlane();
  if (!p || !state.clouds.length) { toast('暂无可导出的检查结果', true); return; }
  const s = computeStats(p);
  const lines = [
    'PCD 点云横平竖直检查报告',
    '生成时间: ' + new Date().toLocaleString(),
    '点云文件: ' + state.clouds.map((c) => c.name + ' (' + c.count + ' pts)').join(', '),
    '分析平面: ' + p.name + '  基准方向: ' + p.axis,
    '平面方程: ' + planeEquation(p),
    '法向量: (' + num(p.normal.x, 6) + ', ' + num(p.normal.y, 6) + ', ' + num(p.normal.z, 6) + ')',
    '偏离理想方向: ' + num(angleToBase(p), 4) + ' deg',
    '参与点数: ' + s.count + ' / ' + s.total,
    '均值偏差: ' + num(s.mean, 6) + ' m',
    'RMS: ' + num(s.rms, 6) + ' m',
    '最大偏差: ' + num(Math.max(Math.abs(s.min), Math.abs(s.max)), 6) + ' m',
    '|d|<=1cm: ' + num(s.w1, 2) + '%',
    '|d|<=2cm: ' + num(s.w2, 2) + '%',
    '',
    '辅助线:',
  ];
  for (const l of state.lines) lines.push('  ' + lineLabel(l) + '  长度 ' + num(l.length, 2) + ' m');
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'pcd-check-report.txt'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updateHUD() {
  const total = state.clouds.reduce((s, c) => s + (c.visible ? c.count : 0), 0);
  $('hud-points').textContent = '点数 ' + total.toLocaleString();
  const p = activePlane();
  $('hud-plane').textContent = p ? '分析平面：' + p.name + ' · 偏角 ' + num(angleToBase(p), 2) + '°' : '分析平面：—';
}

function updateLegend() {
  const bar = document.querySelector('.legend-bar');
  const mode = state.colorMode;
  const setLabels = (arr) => { for (let i = 0; i < 5; i++) $('legend-l' + i).textContent = arr[i]; };
  const quint = (minv, maxv, d) => {
    const s = maxv - minv;
    return [minv, minv + s * 0.25, minv + s * 0.5, minv + s * 0.75, maxv].map((v) => num(v, d));
  };
  let grad, caption;
  if (mode === 'deviation') {
    grad = 'linear-gradient(90deg,#2e47bd 0%,#1fa8cc 25%,#47c761 50%,#f0b833 75%,#c74d42 100%)';
    const R = state.devRange;
    setLabels(['-' + num(R, 3), '-' + num(R / 2, 3), '0', '+' + num(R / 2, 3), '+' + num(R, 3)]);
    caption = '深蓝→青→绿→琥珀→红（绿=共面）；超出 ±' + num(R, 3) + ' m 为半透明深灰';
  } else if (mode === 'intensity') {
    grad = 'linear-gradient(90deg,#1a0b73 0%,#00bfff 25%,#0ce640 50%,#ffe000 75%,#ff1f14 100%)';
    setLabels(quint(state.intensityRange[0], state.intensityRange[1], 2));
    caption = '反射强度 / intensity';
  } else if (mode === 'height') {
    grad = 'linear-gradient(90deg,#1a0b73 0%,#00bfff 25%,#0ce640 50%,#ffe000 75%,#ff1f14 100%)';
    setLabels(quint(state.heightRange[0], state.heightRange[1], 2));
    caption = '按 Z 坐标着色（单位 m）';
  } else {
    const c = mode === 'single' ? state.singleColor : '#b8c9dc';
    grad = 'linear-gradient(90deg,' + c + ',' + c + ')';
    setLabels(['', '', '', '', '']);
    caption = mode === 'single' ? '单色' : '文件自带 RGB（无 RGB 时显示浅灰）';
  }
  bar.style.background = grad;
  $('legend-caption').textContent = caption;
}

// ---------------------------------------------------------------- compass
const cctx = $('compass').getContext('2d');
function drawCompass() {
  const w = 112, c = 56;
  cctx.clearRect(0, 0, w, w);
  cctx.fillStyle = 'rgba(14,19,26,.72)';
  cctx.beginPath(); cctx.arc(c, c, 45, 0, Math.PI * 2); cctx.fill();
  cctx.strokeStyle = '#2a3341'; cctx.lineWidth = 1; cctx.stroke();
  const q = camera.quaternion.clone().invert();
  const ax = [
    { v: new THREE.Vector3(1, 0, 0), col: '#ff6b6b', t: 'X' },
    { v: new THREE.Vector3(0, 1, 0), col: '#69f58e', t: 'Y' },
    { v: new THREE.Vector3(0, 0, 1), col: '#6bb6ff', t: 'Z' },
  ];
  for (const a of ax) {
    const v = a.v.clone().applyQuaternion(q);
    const x = c + v.x * 32, y = c - v.y * 32;
    cctx.globalAlpha = 0.45 + 0.55 * clamp(v.z, 0, 1);
    cctx.strokeStyle = a.col; cctx.lineWidth = 2.5;
    cctx.beginPath(); cctx.moveTo(c, c); cctx.lineTo(x, y); cctx.stroke();
    cctx.fillStyle = a.col; cctx.font = 'bold 11px monospace';
    cctx.textAlign = 'center'; cctx.textBaseline = 'middle';
    cctx.fillText(a.t, c + v.x * 40, c - v.y * 40);
  }
  cctx.globalAlpha = 1;
  cctx.fillStyle = '#8b98a8'; cctx.font = '9px monospace';
  cctx.textAlign = 'center'; cctx.fillText('Z 为竖直方向', c, 105);
}

// ---------------------------------------------------------------- pointer / placement
const raycaster = new THREE.Raycaster();
const placementPreview = new THREE.Group();
{
  const L = 0.45;
  const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
  const pts = [new THREE.Vector3(-L, 0, 0), new THREE.Vector3(L, 0, 0),
    new THREE.Vector3(0, -L, 0), new THREE.Vector3(0, L, 0),
    new THREE.Vector3(0, 0, -L), new THREE.Vector3(0, 0, L)];
  placementPreview.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), mat));
  placementPreview.visible = false;
  scene.add(placementPreview);
}

function intersectActivePlane(clientX, clientY) {
  const p = activePlane();
  if (!p) return null;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  const plane = new THREE.Plane(p.normal.clone(), -p.dist);
  const hit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, hit) ? hit : null;
}

let pointerDown = null;
canvas.addEventListener('pointerdown', (e) => { pointerDown = { x: e.clientX, y: e.clientY, button: e.button }; });
canvas.addEventListener('pointerup', (e) => {
  if (!pointerDown || e.button !== 0) { pointerDown = null; return; }
  const moved = Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y);
  pointerDown = null;
  if (moved > 4 || state.placeMode === 'none') return;
  const hit = intersectActivePlane(e.clientX, e.clientY);
  if (!hit) { toast('请点击分析平面上的位置', true); return; }
  addGuideLine({ dir: state.placeMode, point: [hit.x, hit.y, hit.z], color: $('line-color').value });
  toast('已放置辅助线');
});
canvas.addEventListener('pointermove', (e) => {
  const hit = intersectActivePlane(e.clientX, e.clientY);
  if (!hit) {
    $('hud-hover').textContent = 'X — · Y — · Z —';
    placementPreview.visible = false;
    return;
  }
  const p = activePlane();
  const d = p.normal.dot(hit) - p.dist;
  $('hud-hover').textContent = 'X ' + num(hit.x, 2) + ' · Y ' + num(hit.y, 2) + ' · Z ' + num(hit.z, 2) + ' · 距面 ' + num(d, 3) + ' m';
  placementPreview.visible = state.placeMode !== 'none';
  placementPreview.position.copy(hit);
  const s = clamp(boundsSpan() * 0.02, 0.05, 0.6);
  placementPreview.scale.setScalar(s);
});
canvas.addEventListener('pointerleave', () => { placementPreview.visible = false; });

// ---------------------------------------------------------------- UI wiring
$('btn-upload').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
$('btn-demo').addEventListener('click', () => {
  try {
    const buf = createSamplePCDs().binary;
    addCloudFromBuffer('示例房间.pcd', buf);
    toast('已载入示例房间（地面约 0.67° 倾斜、墙面约 1.03° 倾斜）');
  } catch (err) { toast('示例载入失败：' + err.message, true); }
});
$('btn-clear').addEventListener('click', clearClouds);
$('btn-screenshot').addEventListener('click', () => {
  renderer.render(scene, camera);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = 'pcd-view.png'; a.click();
});

async function handleFiles(files) {
  const list = Array.from(files).filter((f) => /\.(pcd|txt|bin)$/i.test(f.name));
  if (!list.length) { toast('请选择 .pcd 文件', true); return; }
  for (const f of list) {
    try {
      const buf = await f.arrayBuffer();
      addCloudFromBuffer(f.name, buf);
      toast('已载入 ' + f.name + '（' + f.size + ' 字节）');
    } catch (err) { toast(f.name + '：' + err.message, true); }
  }
}

let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (hasFiles(e)) { dragDepth++; $('drop-hint').classList.add('show'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('drop-hint').classList.remove('show'); });
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('drop-hint').classList.remove('show');
  if (e.dataTransfer) handleFiles(e.dataTransfer.files);
});

$('color-mode').addEventListener('change', (e) => {
  state.colorMode = e.target.value;
  uniforms.uColorMode.value = COLOR_MODE_ID[state.colorMode];
  updateLegend();
});
$('point-size').addEventListener('input', (e) => {
  state.pointSize = Number(e.target.value);
  uniforms.uSize.value = state.pointSize;
  $('point-size-val').textContent = state.pointSize + ' px';
});
$('size-mode').addEventListener('change', (e) => {
  state.sizeMode = e.target.value;
  uniforms.uSizeMode.value = state.sizeMode === 'fixed' ? 1 : 0;
});
$('single-color').addEventListener('input', (e) => {
  state.singleColor = e.target.value;
  uniforms.uBaseColor.value.set(e.target.value);
  updateLegend();
});
$('point-opacity').addEventListener('input', (e) => {
  state.opacity = Number(e.target.value);
  uniforms.uOpacity.value = state.opacity;
  $('point-opacity-val').textContent = Math.round(state.opacity * 100) + '%';
});
$('bg-color').addEventListener('input', (e) => renderer.setClearColor(e.target.value, 1));
$('show-axes').addEventListener('change', (e) => { axesHelper.visible = e.target.checked; });
$('show-bbox').addEventListener('change', (e) => { boxHelper.visible = e.target.checked; });
$('show-ticks').addEventListener('change', (e) => {
  state.showTicks = e.target.checked;
  for (const l of state.lines) buildGuideGeometry(l.group, l, state.showTicks);
});
for (const btn of document.querySelectorAll('[data-view]')) {
  btn.addEventListener('click', () => setView(btn.getAttribute('data-view')));
}
$('btn-reset').addEventListener('click', fitView);

$('active-plane').addEventListener('change', (e) => {
  state.activePlaneId = e.target.value === 'none' ? null : Number(e.target.value);
  syncActivePlaneUniforms();
  updateReport();
  updateHUD();
});
$('clip-thickness').addEventListener('input', (e) => {
  state.clipThickness = Number(e.target.value);
  uniforms.uClipThickness.value = state.clipThickness;
  $('clip-thickness-val').textContent = state.clipThickness ? num(state.clipThickness, 3) + ' m' : '关';
  updateReport();
});
$('dev-range').addEventListener('input', (e) => {
  state.devRange = Number(e.target.value);
  uniforms.uDevRange.value = state.devRange;
  $('dev-range-val').textContent = num(state.devRange, 3) + ' m';
  updateLegend();
});
$('outside-alpha').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  uniforms.uOutsideAlpha.value = v;
  $('outside-alpha-val').textContent = Math.round(v * 100) + '%';
});
$('fit-radius').addEventListener('input', (e) => {
  state.fitRadius = Number(e.target.value);
  $('fit-radius-val').textContent = num(state.fitRadius, 3) + ' m';
  updateReport();
});
$('btn-add-plane').addEventListener('click', () => {
  if (state.planes.length >= 6) { toast('最多 6 个辅助平面', true); return; }
  const p = makePlane('辅助面 ' + (state.planes.length + 1), '+X', PLANE_COLORS[state.planes.length % PLANE_COLORS.length]);
  updatePlaneRanges(p);
  autoPlacePlane(p);
  syncPlaneUI(p);
  updatePlaneVisual(p);
  refreshActivePlaneSelect();
  onPlaneTransformChanged();
});
$('place-mode').addEventListener('change', (e) => {
  state.placeMode = e.target.value;
  $('place-hint').textContent = state.placeMode === 'none'
    ? '关闭后视图仅用于旋转 / 平移，不会放置辅助线。'
    : '在视图中点击分析平面，即可在命中点放置辅助线（拖动旋转不会误触）。';
  if (state.placeMode === 'none') placementPreview.visible = false;
});
$('btn-add-cross').addEventListener('click', () => addGuideLine({ dir: 'cross', point: [0, 0, 0], color: '#ffffff' }));
$('btn-add-axes').addEventListener('click', () => {
  const L = defaultLineLength();
  addGuideLine({ dir: 'x', point: [0, 0, 0], length: L, color: '#ff6b6b' });
  addGuideLine({ dir: 'y', point: [0, 0, 0], length: L, color: '#69f58e' });
  addGuideLine({ dir: 'z', point: [0, 0, 0], length: L, color: '#6bb6ff' });
});
$('btn-add-line').addEventListener('click', () => {
  const pt = [Number($('line-x').value), Number($('line-y').value), Number($('line-z').value)];
  if (pt.some((v) => !Number.isFinite(v))) { toast('坐标无效', true); return; }
  addGuideLine({ dir: $('line-dir').value, point: pt, length: Number($('line-length').value) || 5, color: $('line-color').value });
});
$('btn-clear-lines').addEventListener('click', clearLines);
$('btn-export-report').addEventListener('click', exportReport);
$('toggle-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));

document.addEventListener('keydown', (e) => {
  if (e.target && e.target.matches && e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === '1') setView('iso');
  else if (k === '2') setView('top');
  else if (k === '3') setView('front');
  else if (k === '4') setView('side');
  else if (k === 'r') fitView();
  else if (k === 'f') { const p = activePlane(); if (p) fitNearby(p); }
  else if (k === 'c') {
    const v = state.clipThickness > 0 ? 0 : 0.05;
    $('clip-thickness').value = String(v);
    $('clip-thickness').dispatchEvent(new Event('input'));
  }
});

function onResize() {
  const w = stage.clientWidth, hh = stage.clientHeight;
  if (!w || !hh) return;
  renderer.setSize(w, hh, false);
  camera.aspect = w / hh;
  camera.updateProjectionMatrix();
  uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * RAD / 2));
}
window.addEventListener('resize', onResize);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  drawCompass();
}

// ---------------------------------------------------------------- boot
makePlane('水平参考面', '+Z', PLANE_COLORS[0]);
makePlane('竖直参考面', '+Y', PLANE_COLORS[1]);
state.activePlaneId = state.planes[0].id;
refreshActivePlaneSelect();
syncActivePlaneUniforms();
renderFileList();
renderLineList();
updateLegend();
updateReport();
onResize();
animate();

window.__appReady = true;
$('boot').remove();
window.__pcdViz = {
  state, scene, camera, renderer, uniforms, controls, pointMat,
  parsePCD, addCloudFromBuffer, clearClouds, refreshGlobalStats,
  makePlane, removePlane, activePlane, fitNearby, ransacPlane, applyFit,
  addGuideLine, clearLines, setView, updateReport, updateLegend,
  setColorMode(mode) { $('color-mode').value = mode; $('color-mode').dispatchEvent(new Event('change')); },
  setClip(v) { $('clip-thickness').value = String(v); $('clip-thickness').dispatchEvent(new Event('input')); },
};
