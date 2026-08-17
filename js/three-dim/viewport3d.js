/* ============================================================
 * 小宝CAD 3D 视口 —— Three.js WebGL 渲染 / 轨道相机 / 拾取 / 高亮
 * ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Emitter } from '../util.js';

export class Viewport3D extends Emitter {
  constructor(container) {
    super();
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#101116');
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200000);
    this.camera.position.set(160, 120, 220);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.target.set(0, 0, 0);
    this.controls.maxPolarAngle = Math.PI * 0.95;

    // 灯光
    this.scene.add(new THREE.HemisphereLight('#dfe8ff', '#2a2d36', 1.1));
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(300, 500, 250);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -400;
    sun.shadow.camera.right = 400;
    sun.shadow.camera.top = 400;
    sun.shadow.camera.bottom = -400;
    sun.shadow.camera.far = 2000;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#9db4ff', 0.55);
    fill.position.set(-250, 100, -200);
    this.scene.add(fill);

    // 地面网格与坐标轴
    this.grid = new THREE.GridHelper(400, 40, '#3d4250', '#23262e');
    this.scene.add(this.grid);
    const axes = new THREE.AxesHelper(120);
    this.scene.add(axes);

    // 实体显示组
    this.bodyGroup = new THREE.Group();
    this.scene.add(this.bodyGroup);
    this._meshes = new Map(); // modelId → Mesh

    // 拾取
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Mesh.threshold = 0.6;

    this._resize();
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(container);

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    this._onDown = null;
    this.renderer.domElement.addEventListener('click', (e) => { this._onDown?.(e); });
  }
  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w < 2 || h < 2) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  _loop() {
    requestAnimationFrame(this._loop);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /* ---------- 实体显示 ---------- */
  /** meshes: [{ modelId, positions: Float32Array, indices: Uint32Array, color }] */
  setBodies(meshes) {
    const seen = new Set();
    for (const m of meshes) {
      seen.add(m.modelId);
      let mesh = this._meshes.get(m.modelId);
      if (!mesh) {
        const geo = new THREE.BufferGeometry();
        const mat = new THREE.MeshStandardMaterial({
          color: m.color || '#7fb2e8', metalness: 0.12, roughness: 0.45,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        });
        mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.modelId = m.modelId;
        this._meshes.set(m.modelId, mesh);
        this.bodyGroup.add(mesh);
      }
      const geo = mesh.geometry;
      geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      mesh.material.color.set(m.color || '#7fb2e8');
      mesh.material.emissive.set(0x000000);
      mesh.material.opacity = 1;
      mesh.material.transparent = false;
      mesh.visible = true;
      mesh.userData.__stale = false;
    }
    // 移除已不存在的
    for (const [id, mesh] of this._meshes) {
      if (!seen.has(id)) {
        this.bodyGroup.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        this._meshes.delete(id);
      }
    }
  }
  highlight(id) {
    for (const [mid, mesh] of this._meshes) {
      if (mid === id) {
        mesh.material.emissive.set(0x3a2a10);
        mesh.material.emissiveIntensity = 0.9;
      } else {
        mesh.material.emissive.set(0x000000);
      }
    }
  }
  setGround(enabled) { this.grid.visible = enabled; }
  /** 显示模式：shaded 着色 / wireframe 线框 */
  setViewMode(mode) {
    this._viewMode = mode;
    for (const mesh of this._meshes.values()) {
      mesh.material.wireframe = mode === 'wireframe';
      mesh.material.opacity = 1;
    }
  }
  getViewMode() { return this._viewMode || 'shaded'; }
  fitView(bbox) {
    if (!bbox) { this.controls.target.set(0, 0, 0); return; }
    const cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2, cz = (bbox.minZ + bbox.maxZ) / 2;
    const r = Math.max(
      Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, bbox.maxZ - bbox.minZ) / 2,
      10
    );
    this.controls.target.set(cx, cy, cz);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, r * 2.6);
    this.controls.update();
  }

  /* ---------- 拾取 ---------- */
  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.bodyGroup.children, false);
    for (const h of hits) {
      if (h.object.userData?.modelId != null) return h.object.userData.modelId;
    }
    return null;
  }
  onClick(fn) { this._onDown = fn; }
  dispose() {
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}
