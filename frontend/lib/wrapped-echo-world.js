import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

// Validate once at the renderer boundary. Only these display fields may reach
// a canvas texture; account identifiers never belong in the visual world.
export function prepareEchoData(year, data, privacy = false) {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) throw new TypeError('年度必须是 1900–9999 之间的年份。');
  for (const key of ['months', 'hours', 'contacts', 'phrases', 'emojis']) {
    if (!Array.isArray(data?.[key])) throw new TypeError(`场景数据 ${key} 必须为数组。`);
  }
  const count = value => {
    if (!Number.isFinite(value) || value < 0) throw new TypeError('统计数量必须是非负数字。');
    return value;
  };
  const text = value => {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('场景标签必须是非空文字。');
    return value;
  };
  const seen = new Set();
  const months = data.months.map(item => {
    if (!Number.isInteger(item.month) || item.month < 1 || item.month > 12 || seen.has(item.month)) throw new TypeError('月份必须为不重复的 1–12。');
    seen.add(item.month);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][item.month - 1];
    if (item.days !== days || !Array.isArray(item.counts) || item.counts.length !== days) throw new TypeError(`${year} 年 ${item.month} 月的日期数量不正确。`);
    return { month: item.month, days, counts: item.counts.map(count) };
  });
  if (data.hours.length !== 0 && data.hours.length !== 24) throw new TypeError('时段数据必须为空或包含 24 个小时。');
  return {
    months, hours: data.hours.map(count),
    contacts: data.contacts.map((item, i) => ({ displayName: privacy ? `联系人 ${i + 1}` : text(item.displayName) })),
    phrases: data.phrases.map((item, i) => ({ word: privacy ? `短句 ${i + 1}` : text(item.word), count: count(item.count) })),
    emojis: data.emojis.map((item, i) => {
      count(item.count);
      if (privacy) return { label: `表情 ${i + 1}`, count: item.count };
      if (item.url != null && typeof item.url !== 'string') throw new TypeError('表情地址必须为文字。');
      if (item.emoji != null && typeof item.emoji !== 'string') throw new TypeError('文字表情必须为文字。');
      return { label: text(item.label), url: item.url, emoji: item.emoji, count: item.count };
    }),
  };
}

export function createEchoWorld(canvas, { onPick, onError, year, data, privacy = false, motion = true, exportMode = false } = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('createEchoWorld 需要 HTMLCanvasElement。');
  let displayData = prepareEchoData(year, data, privacy);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  } catch (cause) {
    const error = new Error('无法创建 WebGL 场景，请检查浏览器硬件加速与显卡支持。', { cause });
    onError?.(error);
    throw error;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.info.autoReset = false;
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    throw new Error(`WebGL 着色器编译失败：${[gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].filter(Boolean).join('\n')}`);
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(49, 1, 0.1, 160);
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.55, 1.0);
  const outputPass = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(outputPass);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const palette = [
    ['#080e0b', '#687041', '#dbe5a2', '#d99a56'],
    ['#111612', '#4f6654', '#dcf5c7', '#eece8e'],
    ['#09151a', '#355958', '#d7ede0', '#67cbd3'],
    ['#0b1020', '#344151', '#accbea', '#ccafe5'],
    ['#06131e', '#274c5c', '#bce2ec', '#7bcbf2'],
    ['#161022', '#584563', '#e6d5f1', '#c1a1ed'],
    ['#111426', '#3a4664', '#bddae6', '#cea9e8'],
    ['#090f13', '#33434a', '#c3d0cb', '#a7d2dc'],
    ['#0b101d', '#333c57', '#c4c8e8', '#b298dd'],
    ['#1b2021', '#596e68', '#ecdfc2', '#ffd59e'],
  ];
  let sceneIndex = -1;
  let root = null;
  let pickables = [];
  let selectable = [];
  let floating = [];
  let textures = [];
  let reflectors = [];
  let geometries = {};
  let materialCache = new Map();
  let dust;
  let water;
  let metricGroups = {};
  let gatherObjects = [];
  let orbit = null;
  let selection = new Map();
  let frameId = 0;
  let motionWanted = motion;
  let capturing = exportMode;
  let disposed = false;
  let generation = 0;
  let pendingTextures = [];
  let labelRedraws = [];
  let sceneError = null;
  let rendered = false;
  const captureAborts = new Set();
  let pointerDown = null;
  let width = 1;
  let height = 1;
  let time = 0;
  let lastTime = 0;
  let cameraHome = new THREE.Vector3();
  const parallaxTarget = new THREE.Vector2();
  const parallax = new THREE.Vector2();
  const target = new THREE.Vector3();
  const color = new THREE.Color();

  function material(hex, glow = 0, extra = {}) {
    const key = hex + '/' + glow + '/' + JSON.stringify(extra);
    if (!materialCache.has(key)) {
      materialCache.set(key, new THREE.MeshStandardMaterial({
        color: hex, roughness: 0.68, metalness: 0.12,
        emissive: glow ? hex : '#000000', emissiveIntensity: glow, ...extra,
      }));
    }
    return materialCache.get(key);
  }
  function mesh(geometry, mat, position, scale, parent = root) {
    const object = new THREE.Mesh(geometry, mat);
    object.position.set(...position);
    if (scale) object.scale.set(...scale);
    parent.add(object);
    return object;
  }
  function box(w, h, d, hex, x, y, z, glow = 0, parent = root) {
    return mesh(geometries.box, material(hex, glow), [x, y, z], [w, h, d], parent);
  }
  function sphere(radius, hex, x, y, z, parent = root, extra = {}) {
    return mesh(geometries.sphere, material(hex, 0, extra), [x, y, z], [radius, radius, radius], parent);
  }
  function cylinder(radius, h, hex, x, y, z, parent = root, glow = 0) {
    return mesh(geometries.cylinder, material(hex, glow), [x, y, z], [radius, h, radius], parent);
  }
  function light(hex, intensity, x, y, z, distance = 28) {
    const object = new THREE.PointLight(hex, intensity, distance, 2);
    object.position.set(x, y, z);
    root.add(object);
    return object;
  }
  function float(object, amount = 0.12, speed = 0.6, spin = 0) {
    floating.push({ object, base: object.position.clone(), amount, speed, spin, phase: floating.length * 1.73 });
    return object;
  }
  function pick(object, kind, value, highlights = []) {
    object.userData.pick = { kind, value };
    pickables.push(object);
    selectable.push({ object, kind, value, highlights, baseScale: object.scale.clone() });
    return object;
  }
  function label(text, w = 3, h = 0.6, tint = '#edf1db', background = null) {
    const image = document.createElement('canvas');
    image.width = 768;
    image.height = 192;
    const ctx = image.getContext('2d');
    if (!ctx) throw new Error('无法创建文字贴图。');
    const texture = new THREE.CanvasTexture(image);
    const draw = () => {
      ctx.clearRect(0, 0, 768, 192);
      if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, 768, 192); }
      ctx.font = '600 76px "Microsoft YaHei", sans-serif';
      const measured = ctx.measureText(text).width;
      if (measured > 710) ctx.font = `600 ${Math.floor(76 * 710 / measured)}px "Microsoft YaHei", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = tint;
      ctx.shadowColor = tint; ctx.shadowBlur = 8;
      ctx.fillText(text, 384, 96); texture.needsUpdate = true;
    };
    draw(); labelRedraws.push(draw);
    texture.colorSpace = THREE.SRGBColorSpace;
    textures.push(texture);
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({
      map: texture, emissiveMap: texture, emissive: '#ffffff', emissiveIntensity: 0.85,
      transparent: true, side: THREE.DoubleSide, roughness: 0.7, depthWrite: false,
    }));
  }
  function emojiArt(item, group) {
    if (privacy || !item.url) {
      const object = label(privacy ? item.label : item.emoji || item.label, 1.45, 1.2, '#ffffff');
      object.position.z = 1.13; group.add(object);
      return;
    }
    const token = generation;
    const status = label('载入中', 1.45, 0.45, '#dce5ec');
    status.position.z = 1.14; group.add(status);
    const task = new Promise(resolve => {
      new THREE.TextureLoader().load(item.url, texture => {
        if (disposed || token !== generation) { texture.dispose(); resolve(); return; }
        texture.colorSpace = THREE.SRGBColorSpace;
        textures.push(texture);
        const art = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 1.55), new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
        art.position.z = 1.15; group.add(art); status.visible = false;
        try { render(); } catch (error) { reportError(error); }
        resolve();
      }, undefined, cause => {
        if (disposed || token !== generation) { resolve(); return; }
        status.visible = false;
        const failure = label('表情加载失败', 1.8, 0.45, '#ffc1b2');
        failure.position.z = 1.16; group.add(failure);
        reportError(new Error(`表情「${item.label}」加载失败，请修复素材后重试。`, { cause }));
        try { render(); } catch (error) { reportError(error); }
        resolve();
      });
    });
    pendingTextures.push(task);
  }
  function textAt(text, x, y, z, w = 3, h = 0.6, tint) {
    const object = label(text, w, h, tint);
    object.position.set(x, y, z);
    root.add(object);
    return object;
  }
  function floorGrid(hex) {
    const image = document.createElement('canvas');
    image.width = image.height = 128;
    const ctx = image.getContext('2d');
    ctx.strokeStyle = hex;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(image);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(26, 65);
    textures.push(texture);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(24, 68), new THREE.MeshBasicMaterial({
      map: texture, transparent: true, opacity: 0.18, depthWrite: false,
    }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(3, 0.018, -19);
    root.add(plane);
  }
  function reflection(hex, y = 0, w = 24, d = 68, z = -19) {
    const object = new Reflector(new THREE.PlaneGeometry(w, d), {
      color: hex, clipBias: 0.005, textureWidth: 768, textureHeight: 512, multisample: 0,
    });
    object.rotation.x = -Math.PI / 2;
    object.position.set(3, y, z);
    root.add(object);
    reflectors.push(object);
  }
  function room({ walls = true, ceiling = true, pillars = true, mirror = true, pool = false } = {}) {
    const p = palette[sceneIndex];
    scene.background = new THREE.Color(p[0]);
    scene.fog = new THREE.FogExp2(p[0], pool ? 0.023 : 0.025);
    box(26, 0.3, 74, p[1], 3, -0.2, -20);
    if (mirror) reflection(pool ? '#607c89' : '#6e7773');
    floorGrid(pool ? '#8dd6e5' : p[2]);
    if (walls) {
      box(0.35, 10, 74, p[1], -10, 5, -20);
      box(0.35, 10, 74, p[1], 16, 5, -20);
      box(26, 10, 0.3, p[1], 3, 5, -57);
    }
    if (ceiling) box(26, 0.25, 74, p[1], 3, 10, -20);
    const ambient = new THREE.HemisphereLight(p[2], '#1b262c', 1.1);
    root.add(ambient);
    const sun = new THREE.DirectionalLight(p[2], 1.6);
    sun.position.set(-2, 12, 4);
    root.add(sun);
    light(p[3], 72, 6, 6, -8, 40);
    light(p[2], 55, 1, 5, -33, 35);
    if (pillars) for (let i = 0; i < 9; i++) {
      const z = 5 - i * 7;
      for (const x of [-6, 12]) {
        box(0.9, 9.6, 0.9, p[1], x, 4.8, z);
        box(1.3, 0.25, 1.3, p[2], x, 0.15, z);
        box(0.12, 6.4, 0.14, p[3], x - 0.45, 4.5, z, 1.2);
      }
      if (ceiling) box(8.5, 0.055, 0.18, p[2], 3, 9.75, z, 2.0);
    }
  }
  function door(x, y, z, w = 2, h = 4, tint = palette[sceneIndex][2], parent = root) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    parent.add(group);
    const highlights = [
      box(0.13, h, 0.2, tint, -w / 2, h / 2, 0, 1.4, group),
      box(0.13, h, 0.2, tint, w / 2, h / 2, 0, 1.4, group),
      box(w, 0.13, 0.2, tint, 0, h, 0, 1.4, group),
    ];
    const surface = mesh(geometries.box, new THREE.MeshStandardMaterial({
      color: tint, emissive: tint, emissiveIntensity: 0.22,
      transparent: true, opacity: 0.13, depthWrite: false, roughness: 0.7,
    }), [0, h / 2, 0.05], [w, h, 0.06], group);
    group.userData.highlights = [...highlights, surface];
    group.userData.surface = surface;
    return group;
  }
  function silhouette(x, y, z, h = 3) {
    const image = document.createElement('canvas');
    image.width = 128; image.height = 256;
    const ctx = image.getContext('2d');
    ctx.filter = 'blur(9px)';
    ctx.fillStyle = '#070c12';
    ctx.beginPath(); ctx.ellipse(64, 54, 16, 21, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(64, 142, 25, 74, 0, 0, Math.PI * 2); ctx.fill();
    const texture = new THREE.CanvasTexture(image);
    textures.push(texture);
    const object = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, transparent: true, opacity: 0.42, depthWrite: false, fog: true,
    }));
    object.position.set(x, y + h / 2, z);
    object.scale.set(h * 0.52, h, 1);
    root.add(object);
  }
  function particles() {
    const count = 750;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = Math.sin(i * 127.1 + 17.2) * 43758.5453;
      const b = Math.sin(i * 311.7 + 31.4) * 28463.927;
      const c = Math.sin(i * 74.7 + 9.8) * 39218.33;
      positions.set([(a - Math.floor(a)) * 26 - 10, (b - Math.floor(b)) * 11,
        9 - (c - Math.floor(c)) * 68], i * 3);
      color.set(palette[sceneIndex][i % 3 === 0 ? 3 : 2]);
      colors.set([color.r, color.g, color.b], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    dust = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: 0.036, vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    }));
    root.add(dust);
  }
  function wire(points, hex, radius = 0.035, parent = root) {
    const curve = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point)));
    return mesh(new THREE.TubeGeometry(curve, 64, radius, 8, false), material(hex, 0.35), [0, 0, 0], null, parent);
  }
  function telephone(x, y, z, tint, number, displayName) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    root.add(group);
    box(2.25, 1, 1.55, tint, 0, 0.5, 0, 0, group);
    box(2.7, 0.32, 0.45, tint, 0, 1.4, 0, 0.25, group);
    for (const side of [-1, 1]) {
      const ear = sphere(0.42, tint, side * 1.12, 1.25, 0, group, { roughness: 0.3 });
      ear.scale.y = 0.7;
    }
    const dial = cylinder(0.44, 0.07, '#dedac5', 0, 1.02, 0.26, group);
    for (let i = 0; i < 10; i++) {
      const a = i / 10 * Math.PI * 2;
      sphere(0.06, '#242b2c', Math.cos(a) * 0.3, 1.07, 0.26 + Math.sin(a) * 0.3, group);
    }
    const stamp = label(displayName, 2, 0.35, '#e7ddcb');
    stamp.position.set(0, 0.55, 0.79); group.add(stamp);
    wire([[x + 1.3, y + 1.25, z], [x + 1.8, y + 0.4, z + 1.2],
      [x + 2.7, 0.15, z + 2], [x + 5, 0.12, z - 4]], tint, 0.045);
    return pick(group, 'contact', number, [dial]);
  }
  function build(index) {
    if (index === 0) {
      room({});
      const entry = door(3.3, 0, -38, 3.5, 7, '#eff5be');
      pick(entry, 'entry', 1, entry.userData.highlights);
      for (let i = 0; i < 5; i++) {
        const frame = door(3.3, 0, -5 - i * 7, 7 - i * 0.65, 7.8, '#9fac77');
        frame.userData.decorative = true;
      }
      box(2.4, 1.6, 2, '#68724a', 5.9, 0.8, -4);
      textAt(String(year), 3.3, 7.4, -17, 4, 1.15, '#d4dab7');
      silhouette(3.3, 0, -39, 3.2);
      light('#ffc576', 35, 5.8, 3, -3);
    } else if (index === 1) {
      room({ pillars: false });
      const dateGeometry = geometries.date = new THREE.BoxGeometry(0.12, 0.12, 0.025);
      for (let i = 0; i < displayData.months.length; i++) {
        const month = displayData.months[i];
        const x = i % 4 * 2.5 + 0.6;
        const y = Math.floor(i / 4) * 2.5 + 0.3;
        const group = door(x, y, -13 - (i % 4) * 0.12, 1.8, 2.1, '#b8d6b6');
        const number = label(String(month.month).padStart(2, '0') + ' 月', 1.25, 0.33, '#ddedc1');
        number.position.set(0, 1.78, 0.2); group.add(number);
        const dayCount = month.days;
        const dates = new THREE.InstancedMesh(dateGeometry, material('#a3be99', 0.4), dayCount);
        const matrix = new THREE.Matrix4();
        const maximum = Math.max(...month.counts);
        const first = new Date(`${year.toString().padStart(4, '0')}-${String(month.month).padStart(2, '0')}-01T12:00:00Z`).getUTCDay();
        for (let j = 0; j < dayCount; j++) {
          const slot = j + first;
          matrix.makeTranslation((slot % 7 - 3) * 0.2, 1.3 - Math.floor(slot / 7) * 0.22, 0.13);
          dates.setMatrixAt(j, matrix);
          dates.setColorAt(j, new THREE.Color('#24352d').lerp(new THREE.Color('#deefab'), maximum === 0 ? 0 : month.counts[j] / maximum));
        }
        group.add(dates);
        pick(group, 'month', month.month, group.userData.highlights);
      }
      if (!displayData.months.length) textAt('暂无日期记录', 4.5, 3.6, -12, 5, 0.8);
      silhouette(13, 0, -24, 4);
    } else if (index === 2) {
      room({ ceiling: false });
      for (let i = 0; i < displayData.contacts.length; i++) {
        const x = 0.5 + (i % 3) * 4;
        const z = -4 - Math.floor(i / 3) * 8 - (i % 3) * 2.1;
        box(2.8, 2.5, 2.4, '#3c5554', x, 1.25, z);
        telephone(x, 2.5, z, ['#b04449', '#429a9e', '#8873b6'][i % 3], i, displayData.contacts[i].displayName);
        const halo = door(x, 0, z - 3.7, 3.1, 7.2, ['#bf7372', '#82cfd0', '#ae99d9'][i % 3]);
        halo.rotation.y = -0.12 + i * 0.08;
      }
      wire([[0.5, 4.2, -4], [3, 7.4, -8], [6, 7.7, -10], [8.5, 4.2, -9.2]], '#8ca6ac');
      textAt(displayData.contacts.length ? '有人在另一端' : '暂无联系人记录', 5, 8.1, -17, 4.5, 0.7, '#bfd6cd');
      silhouette(3, 0, -32, 3.5);
    } else if (index === 3) {
      room({ walls: false, ceiling: false, pillars: false });
      for (let i = 0; i < displayData.months.length; i++) {
        const month = displayData.months[i];
        const z = -4 - i * 3.2;
        const group = door(3.6, 0, z, 6.2, 7.2, i % 2 ? '#a8bddb' : '#cab3dc');
        // Only the nested frames are pickable; the front translucent pane must not hide later months.
        group.userData.surface.raycast = () => {};
        const number = label(String(month.month).padStart(2, '0'), 0.85, 0.48, '#d4d5eb');
        number.position.set(2.4, 6.55, 0.2); group.add(number);
        pick(group, 'month', month.month, group.userData.highlights);
        box(8, 0.12, 0.35, '#889fae', 3.6, 0.08, z, 0.2);
      }
      if (!displayData.months.length) textAt('暂无月份记录', 4.5, 3.6, -12, 5, 0.8);
      wire([[-1.2, 0.03, 6], [-1.2, 0.03, -20], [-1.2, 0.03, -52]], '#8196a6');
      wire([[8.4, 0.03, 6], [8.4, 0.03, -20], [8.4, 0.03, -52]], '#8196a6');
      silhouette(3.6, 0, -41, 3.6);
    } else if (index === 4) {
      room({ walls: false, ceiling: false, pool: true });
      const moon = sphere(5.3, '#bed6dc', 4.8, 10.5, -27, root, {
        emissive: '#88a7b5', emissiveIntensity: 0.38, roughness: 0.94,
      });
      float(moon, 0.12, 0.18);
      water = mesh(new THREE.PlaneGeometry(24, 68), new THREE.ShaderMaterial({
        uniforms: { time: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
        fragmentShader: 'uniform float time; varying vec2 vUv; void main(){float a=sin(vUv.x*150.0+sin(vUv.y*60.0+time*.3)*2.0);float b=sin(vUv.y*190.0-time*.22);float wave=pow(max(0.0,a*b),7.0);gl_FragColor=vec4(mix(vec3(.035,.10,.14),vec3(.20,.45,.50),wave),.09+wave*.16);}',
        transparent: true, depthWrite: false,
      }), [3, 0.035, -19]);
      water.rotation.x = -Math.PI / 2;
      const hourly = displayData.hours;
      const maximum = Math.max(0, ...hourly);
      for (let i = 0; i < hourly.length; i++) {
        const a = i / 24 * Math.PI * 2;
        const h = maximum === 0 ? 0.04 : 0.04 + 3.5 * hourly[i] / maximum;
        const object = cylinder(0.2, h, '#589bbb', 4.3 + Math.cos(a) * 7.3, h / 2,
          -11 + Math.sin(a) * 6, root, 1.0);
        pick(object, 'hour', i, [object]);
        textAt(String(i).padStart(2, '0'), object.position.x, 0.2, object.position.z + 0.5, 0.5, 0.22, '#b9dae0');
      }
      door(4.6, 0, -46, 3.2, 7.4, '#bfe9ec');
      textAt(hourly.length ? 'MIDNIGHT' : '暂无时段记录', 4.6, 5.6, -18, 3, 0.75, '#bfdee5');
      silhouette(12.2, 0, -29, 5);
    } else if (index === 5) {
      room({ ceiling: false });
      const words = displayData.phrases;
      for (let i = 0; i < words.length; i++) {
        const x = 1.5 + (i % 3) * 3.6;
        const y = 3.1 + (Math.floor(i / 3) % 2) * 3.2;
        const z = -5 - (i % 6) * 1.2 - Math.floor(i / 6) * 8;
        const group = new THREE.Group(); group.position.set(x, y, z); root.add(group);
        box(3.05, 1.45, 0.15, '#342f42', 0, 0, 0, 0, group);
        const word = label(words[i].word, 2.8, 0.83, ['#d3c0ed', '#c2d6e7', '#e9c3d4'][i % 3]);
        word.position.z = 0.12; group.add(word);
        box(3.1, 0.055, 0.2, '#c5a7e0', 0, -0.74, 0, 1.6, group);
        float(group, 0.17, 0.3);
        pick(group, 'phrase', i, [word]);
        wire([[x, y + 0.75, z], [x + 0.3, 10, z - 1], [x + 1, 12, z - 2]], '#646076', 0.015);
      }
      door(4.6, 0, -35, 3.5, 7.4, '#baacd9');
      textAt(words.length ? '这些话仍在回荡' : '暂无短句记录', 4.5, 1.2, -19, 4.2, 0.6, '#bdb3d0');
    } else if (index === 6) {
      room({ ceiling: false, walls: false });
      const symbols = displayData.emojis;
      for (let i = 0; i < symbols.length; i++) {
        const x = 1.3 + (i % 3) * 3.9;
        const y = 2.7 + (Math.floor(i / 3) % 2) * 3.4;
        const z = -5 - (i % 6) * 1.6 - Math.floor(i / 6) * 8;
        const group = new THREE.Group(); group.position.set(x, y, z); root.add(group);
        const object = sphere(1.1, ['#94b2c8', '#b99cbe', '#a6a6cd'][i % 3], 0, 0, 0, group, {
          roughness: 0.2, metalness: 0.25, emissive: '#1f253e', emissiveIntensity: 0.5,
        });
        emojiArt(symbols[i], group);
        group.userData.home = group.position.clone();
        group.userData.dragOffset = new THREE.Vector3();
        gatherObjects.push(group);
        float(group, 0.22, 0.35, 0.055);
        pick(group, 'emoji', i, [object]);
      }
      const hoop = mesh(new THREE.TorusGeometry(5.5, 0.075, 12, 96), material('#bca4d5', 1.0), [5, 4.4, -18]);
      hoop.rotation.y = 0.45; hoop.rotation.z = -0.2;
      textAt(symbols.length ? '重力暂时失效' : '暂无表情记录', 4.5, 8.8, -20, 4.5, 0.7, '#c9beda');
    } else if (index === 7) {
      room({ ceiling: false });
      metricGroups = { text: new THREE.Group(), voice: new THREE.Group(), call: new THREE.Group() };
      for (const group of Object.values(metricGroups)) root.add(group);
      const textObject = label('文字', 3.5, 1.8, '#bccfce');
      textObject.position.set(4.2, 3.8, -8); metricGroups.text.add(textObject); float(textObject, 0.12, 0.3);
      for (let i = 0; i < 35; i++) {
        const h = 0.4 + Math.abs(Math.sin(i * 0.57)) * 4;
        box(0.09, h, 0.09, '#8ecad2', 0.6 + i * 0.22, 3.7, -9, 0.8, metricGroups.voice);
      }
      for (const [i, key] of ['text', 'voice', 'call'].entries()) {
        const control = box(1.8, 0.65, 0.2, '#50656c', 2 + i * 2.5, 0.9, -5, 0.5);
        pick(control, 'metric', key, [control]);
        textAt(['文字', '语音', '通话'][i], 2 + i * 2.5, 0.92, -4.88, 1.55, 0.4);
      }
      for (let i = 0; i < 3; i++) {
        const ring = mesh(new THREE.TorusGeometry(1.5 + i * 0.8, 0.06, 12, 80), material('#c5baa0', 0.75),
          [4.5, 3.8, -9 - i * 0.9], null, metricGroups.call);
        ring.rotation.y = i * 0.28;
      }
      box(9, 0.3, 5, '#35464a', 4.5, 0.18, -9);
      textAt('没有声音的剧场', 4.5, 8, -20, 4.6, 0.7, '#cad5cf');
      door(4.5, 0, -40, 3, 6, '#c2d3cd');
    } else if (index === 8) {
      room({ walls: false, ceiling: false, pillars: false });
      orbit = new THREE.Group(); orbit.position.set(4.7, 6.4, -13); root.add(orbit);
      const orb = sphere(4.9, '#131625', 0, 0, 0, orbit, {
        metalness: 0.75, roughness: 0.17, emissive: '#292135', emissiveIntensity: 0.5,
      });
      float(orb, 0.14, 0.2, 0.035);
      for (let i = 0; i < 4; i++) {
        const ring = mesh(new THREE.TorusGeometry(6 + i * 0.38, 0.025, 8, 120),
          material(i % 2 ? '#8c8caf' : '#b9a4ce', 1.1), [0, 0, 0], null, orbit);
        ring.rotation.set(0.9 + i * 0.25, 0.25 + i * 0.42, i * 0.15);
      }
      for (let i = 0; i < 7; i++) {
        const a = i / 7 * Math.PI * 2;
        const group = new THREE.Group();
        group.position.set(Math.cos(a) * 7, -0.9 + Math.sin(a) * 3.5, 5 - (i % 3) * 1.5);
        orbit.add(group);
        const card = box(1.6, 1.05, 0.06, '#9ca9b4', 0, 0, 0, 0.18, group);
        const title = label(['日历', '联系人', '月份', '午夜', '短句', '表情', '文字与声音'][i], 1.35, 0.34, '#eef1e7');
        title.position.z = 0.05; group.add(title);
        group.userData.home = group.position.clone();
        gatherObjects.push(group); float(group, 0.12, 0.27);
        pick(group, 'chapter', i + 1, [card]);
      }
      light('#bbb0e0', 95, 10, 9, -6, 30);
      light('#c9dceb', 55, 1, 3, -6, 25);
    } else {
      room({ ceiling: false, walls: false });
      for (let i = 0; i < 6; i++) {
        const arch = door(4.3, 0, -9 - i * 4.8, 7.5 - i * 0.35, 9.3 - i * 0.2, '#e9d5ad');
        arch.rotation.z = i % 2 ? 0.008 : -0.008;
      }
      const dawn = sphere(5.2, '#e9dcc0', 4.3, 6, -44, root, { emissive: '#ffe9bd', emissiveIntensity: 1.4 });
      const ticket = new THREE.Group(); ticket.position.set(4.4, 3.7, -5); root.add(ticket);
      const paper = box(3.25, 4.15, 0.055, '#f2eddd', 0, 0, 0, 0.05, ticket);
      for (let i = 0; i < 6; i++) box(2.5 - i * 0.22, 0.035, 0.02, '#9eada5', -0.15, 0.2 - i * 0.22, 0.05, 0, ticket);
      const stamp = label(`${year} / 封存`, 2.7, 0.62, '#65746c');
      stamp.position.set(0, 1.22, 0.065); ticket.add(stamp);
      const small = label('带着回声离开', 2.6, 0.45, '#65746c');
      small.position.set(0, -1.45, 0.065); ticket.add(small);
      ticket.rotation.set(-0.06, -0.17, -0.045);
      float(ticket, 0.13, 0.35);
      pick(ticket, 'share', 0, [paper]);
      float(dawn, 0.06, 0.12);
      light('#ffdcaf', 100, 4.3, 7, -30, 48);
    }
    particles();
  }
  function clearScene() {
    generation++;
    pointerDown = null;
    const cancellation = new DOMException('场景已切换或销毁，截图已取消。', 'AbortError');
    for (const reject of captureAborts) reject(cancellation);
    captureAborts.clear();
    if (!root) return;
    scene.remove(root);
    const gs = new Set();
    const ms = new Set();
    for (const geometry of Object.values(geometries)) gs.add(geometry);
    for (const mat of materialCache.values()) ms.add(mat);
    root.traverse(object => {
      if (object.geometry) gs.add(object.geometry);
      if (object.material) for (const mat of (Array.isArray(object.material) ? object.material : [object.material])) ms.add(mat);
    });
    for (const reflector of reflectors) reflector.dispose();
    for (const geometry of gs) geometry.dispose();
    for (const mat of ms) mat.dispose();
    for (const texture of textures) texture.dispose();
    pickables = []; selectable = []; floating = []; textures = []; reflectors = [];
    gatherObjects = []; metricGroups = {}; materialCache.clear(); water = null; dust = null; orbit = null;
    pendingTextures = []; labelRedraws = []; root = null; rendered = false;
  }
  function updateSelection() {
    for (const item of selectable) {
      const active = selection.get(item.kind) === item.value;
      item.object.scale.copy(item.baseScale).multiplyScalar(active ? 1.07 : 1);
      for (const object of item.highlights) {
        // Selection owns cloned materials; shared room materials stay unchanged.
        if (!object.userData.selectionMaterial) {
          object.material = object.material.clone();
          object.userData.selectionMaterial = true;
          object.userData.baseEmissive = object.material.emissiveIntensity ?? 0;
          object.userData.baseColor = object.material.color?.clone();
          object.userData.baseEmissiveColor = object.material.emissive?.clone();
        }
        if (object.material.emissive) {
          object.material.emissive.copy(active ? new THREE.Color('#fff2ba') : object.userData.baseEmissiveColor);
          object.material.emissiveIntensity = active ? 2.1 : object.userData.baseEmissive;
        }
      }
    }
    if (sceneIndex === 7) {
      const selected = selection.get('metric') ?? 'text';
      for (const [key, group] of Object.entries(metricGroups)) group.visible = key === selected;
    }
    if (sceneIndex === 6 || sceneIndex === 8) {
      const gathered = selection.get('gather') === true;
      gatherObjects.forEach((object, i) => {
        const home = object.userData.home;
        const angle = i / gatherObjects.length * Math.PI * 2 + Math.PI / 2;
        const position = gathered
          ? sceneIndex === 6
            ? new THREE.Vector3(5 + Math.cos(angle) * 2.1, 3.8 + Math.sin(angle) * 1.8, -5.8)
            : new THREE.Vector3((i - 3) * 0.56, -4.7, 7.3)
          : home;
        object.position.copy(position);
        if (sceneIndex === 6) {
          object.position.add(object.userData.dragOffset);
          const item = selectable.find(item => item.object === object);
          object.scale.copy(item.baseScale).multiplyScalar(gathered ? 0.78 : 1);
          if (selection.get('emoji') === item.value) object.scale.multiplyScalar(1.07);
        }
        const motion = floating.find(item => item.object === object);
        motion.base.copy(object.position);
      });
    }
  }
  function setScene(index, rebuild = false) {
    if (!Number.isInteger(index) || index < 0 || index > 9) throw new RangeError('场景编号必须为 0–9。');
    if (disposed) throw new Error('场景已销毁。');
    if (index === sceneIndex && !rebuild) return;
    clearScene();
    sceneError = null;
    sceneIndex = index;
    root = new THREE.Group();
    scene.add(root);
    geometries = {
      box: new THREE.BoxGeometry(1, 1, 1),
      sphere: new THREE.SphereGeometry(1, 48, 32),
      cylinder: new THREE.CylinderGeometry(1, 1, 1, 24),
    };
    camera.position.set(-0.7, index === 4 ? 4.5 : 4.1, index === 8 ? 20 : 17);
    target.set(0.5, index === 8 ? 4 : 2.8, index === 3 ? -26 : -14);
    parallaxTarget.set(0, 0);
    parallax.set(0, 0);
    camera.lookAt(target);
    cameraHome.copy(camera.position);
    build(index);
    updateSelection();
    render();
    syncLoop();
  }
  function setSelection(values) {
    if (disposed) throw new Error('场景已销毁。');
    selection = new Map(Object.entries(values));
    updateSelection();
    render();
  }
  function setData(next, index = sceneIndex) {
    if (disposed) throw new Error('场景已销毁。');
    const prepared = prepareEchoData(next.year, next.data, next.privacy);
    year = next.year; privacy = next.privacy; displayData = prepared;
    setScene(index, true);
  }
  function resize() {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (root) render();
  }
  function render() {
    if (disposed || !root) return;
    try {
      renderer.info.reset();
      composer.render();
      rendered = true;
    } catch (error) { reportError(error); throw error; }
  }
  function reportError(error) {
    if (sceneError === error) return;
    sceneError = error;
    rendered = false;
    cancelAnimationFrame(frameId); frameId = 0;
    for (const reject of captureAborts) reject(error);
    captureAborts.clear();
    onError?.(error);
  }
  async function prepareCapture() {
    if (disposed) throw new Error('场景已销毁。');
    if (sceneError) throw sceneError;
    const token = generation;
    const tasks = pendingTextures.slice();
    let abort;
    const cancelled = new Promise((resolve, reject) => { abort = reject; captureAborts.add(reject); });
    try {
      await Promise.race([Promise.all([document.fonts?.ready, ...tasks]), cancelled]);
      if (disposed || token !== generation) throw new DOMException('场景已切换或销毁，截图已取消。', 'AbortError');
      if (sceneError) throw sceneError;
      for (const redraw of labelRedraws) redraw();
      resize(); render();
      renderer.getContext().finish();
      return canvas;
    } finally { captureAborts.delete(abort); }
  }
  function resetView() {
    if (disposed) throw new Error('场景已销毁。');
    pointerDown = null;
    if (orbit) orbit.rotation.set(0, 0, 0);
    if (sceneIndex === 6) for (const object of gatherObjects) object.userData.dragOffset.set(0, 0, 0);
    updateSelection();
    parallaxTarget.set(0, 0); parallax.set(0, 0);
    camera.position.copy(cameraHome); camera.lookAt(target); render();
  }
  function animate(timestamp) {
    frameId = 0;
    const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
    lastTime = timestamp;
    time += Math.max(0, dt);
    for (const item of floating) {
      item.object.position.y = item.base.y + Math.sin(time * item.speed + item.phase) * item.amount;
      if (item.spin) item.object.rotation.y += dt * item.spin;
    }
    if (dust) { dust.rotation.y = Math.sin(time * 0.045) * 0.018; dust.position.y = Math.sin(time * 0.12) * 0.18; }
    if (water) water.material.uniforms.time.value = time;
    parallax.lerp(parallaxTarget, Math.min(1, dt * 4));
    camera.position.copy(cameraHome);
    camera.position.x += parallax.x * 0.48 + Math.sin(time * 0.09) * 0.045;
    camera.position.y += parallax.y * 0.28 + Math.sin(time * 0.13) * 0.025;
    camera.lookAt(target);
    try { render(); } catch (error) {
      reportError(error);
      return;
    }
    if (motionWanted && !capturing && !sceneError && !motionQuery.matches && !document.hidden && !disposed) frameId = requestAnimationFrame(animate);
  }
  function syncLoop() {
    cancelAnimationFrame(frameId); frameId = 0;
    if (disposed) return;
    if (motionWanted && !capturing && !sceneError && !motionQuery.matches && !document.hidden) {
      lastTime = performance.now();
      frameId = requestAnimationFrame(animate);
    } else {
      parallaxTarget.set(0, 0);
      parallax.set(0, 0);
      camera.position.copy(cameraHome);
      camera.lookAt(target);
      render();
    }
  }
  function setMotion(enabled) { motionWanted = Boolean(enabled); syncLoop(); }
  function setExportMode(enabled) { capturing = Boolean(enabled); pointerDown = null; syncLoop(); }
  function blocksPick(event) {
    return event.target instanceof Element && event.target !== canvas &&
      Boolean(event.target.closest('button,a,input,select,textarea,[role="button"],[data-world-block]'));
  }
  function onPointerDown(event) {
    pointerDown = null;
    if (event.button !== 0 || capturing || blocksPick(event) || document.hidden || disposed) return;
    const rect = canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    let dragTarget = null;
    if (sceneIndex === 6 || sceneIndex === 8) {
      let object = hitObject(event, sceneIndex === 8 ? [orbit] : pickables);
      while (object && object !== orbit && object.userData.pick?.kind !== 'emoji') object = object.parent;
      dragTarget = object;
    }
    pointerDown = { x: event.clientX, y: event.clientY, id: event.pointerId, dragged: false, dragTarget,
      rotation: dragTarget === orbit && orbit ? orbit.rotation.clone() : null,
      offset: dragTarget?.userData.dragOffset?.clone() };
  }
  function onPointerMove(event) {
    if (disposed || !root || blocksPick(event) || document.hidden) return;
    const rect = canvas.getBoundingClientRect();
    const x = THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
    const y = THREE.MathUtils.clamp(1 - (event.clientY - rect.top) / rect.height * 2, -1, 1);
    if (capturing) return;
    const start = pointerDown?.id === event.pointerId ? pointerDown : null;
    if (start) {
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Math.hypot(dx, dy) < 5 && !start.dragged) return;
      start.dragged = true;
      if (start.dragTarget) {
        if (start.dragTarget === orbit) {
          orbit.rotation.y = start.rotation.y + dx * 0.006;
          orbit.rotation.x = THREE.MathUtils.clamp(start.rotation.x + dy * 0.004, -0.8, 0.8);
        } else {
          const object = start.dragTarget;
          const offset = new THREE.Vector3(THREE.MathUtils.clamp(start.offset.x + dx * 0.015, -4, 4), THREE.MathUtils.clamp(start.offset.y - dy * 0.015, -3, 3), 0);
          const delta = offset.clone().sub(object.userData.dragOffset);
          object.userData.dragOffset.copy(offset); object.position.add(delta);
          floating.find(item => item.object === object).base.add(delta);
        }
        render();
        return;
      }
    }
    if (motionWanted && !motionQuery.matches) {
      parallaxTarget.set(x, y);
      return;
    }
    // Reduced motion keeps hover still; an intentional drag changes view immediately.
    if (!start?.dragged) return;
    parallax.set(x, y);
    parallaxTarget.copy(parallax);
    camera.position.copy(cameraHome);
    camera.position.x += parallax.x * 0.48;
    camera.position.y += parallax.y * 0.28;
    camera.lookAt(target);
    render();
  }
  function onPointerUp(event) {
    const start = pointerDown; pointerDown = null;
    if (capturing || !start || start.dragged || start.id !== event.pointerId || blocksPick(event) ||
      Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 5) return;
    const rect = canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return;
    let object = hitObject(event, pickables);
    while (object && !object.userData.pick) object = object.parent;
    if (object) onPick?.(object.userData.pick.kind, object.userData.pick.value);
  }
  function hitObject(event, objects) {
    const rect = canvas.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(objects, true)[0]?.object || null;
  }
  function onPointerCancel() { pointerDown = null; }
  function onContextLost(event) {
    event.preventDefault();
    reportError(new Error('WebGL 上下文已丢失，场景渲染已停止，请重新打开年度总结。'));
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  document.addEventListener('visibilitychange', syncLoop);
  motionQuery.addEventListener('change', syncLoop);
  canvas.addEventListener('webglcontextlost', onContextLost);
  try { resize(); setScene(0); }
  catch (error) { dispose(); throw error; }
  function dispose() {
    if (disposed) return;
    cancelAnimationFrame(frameId); frameId = 0; disposed = true;
    observer.disconnect();
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    document.removeEventListener('visibilitychange', syncLoop);
    motionQuery.removeEventListener('change', syncLoop);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    clearScene();
    bloom.dispose(); outputPass.dispose(); composer.dispose(); renderer.dispose();
  }
  return {
    setScene, setData, setSelection, setMotion, setExportMode, prepareCapture, resetView, render, dispose,
    getState() {
      return { scene: sceneIndex, width, height, running: Boolean(frameId), reducedMotion: motionQuery.matches,
        generation, rendered, disposed, error: sceneError?.message || '', exportMode: capturing,
        drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
        orbitRotation: orbit ? orbit.rotation.toArray().slice(0, 3) : null,
        emojiOffsets: sceneIndex === 6 ? gatherObjects.map(object => object.userData.dragOffset.toArray()) : [],
        particles: dust?.geometry.attributes.position.count ?? 0, pickTargets: pickables.length };
    },
  };
}
