// Orientation cube: mirrors the main camera and lets you click a face to snap the view.
import * as THREE from 'three';

const FACES = [
  { name: 'top', label: 'TOP', n: [0, 0, 1], u: [0, 1, 0] },
  { name: 'bottom', label: 'BOTTOM', n: [0, 0, -1], u: [0, -1, 0] },
  { name: 'front', label: 'FRONT', n: [0, -1, 0], u: [0, 0, 1] },
  { name: 'back', label: 'BACK', n: [0, 1, 0], u: [0, 0, 1] },
  { name: 'right', label: 'RIGHT', n: [1, 0, 0], u: [0, 0, 1] },
  { name: 'left', label: 'LEFT', n: [-1, 0, 0], u: [0, 0, 1] },
];

function labelTexture(text, dark, hover) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = hover ? '#4f8cff' : dark ? '#2b303a' : '#f4f6f9';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = dark ? '#4a5160' : '#c3c9d4';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 122, 122);
  g.fillStyle = hover ? '#ffffff' : dark ? '#d8dce4' : '#3a4150';
  g.font = '600 24px Inter, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class ViewCube {
  constructor(container, { onSelect }) {
    this.container = container;
    this.onSelect = onSelect;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    this.cube = new THREE.Group();
    this.faces = FACES.map((f) => {
      const mat = new THREE.MeshBasicMaterial({ map: labelTexture(f.label, true, false) });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      const n = new THREE.Vector3(...f.n), u = new THREE.Vector3(...f.u);
      const r = new THREE.Vector3().crossVectors(u, n);
      mesh.matrix.makeBasis(r, u, n).setPosition(n.clone().multiplyScalar(0.5));
      mesh.matrixAutoUpdate = false;
      mesh.userData = f;
      this.cube.add(mesh);
      return mesh;
    });
    const axes = [[1, 0, 0, '#e5534b'], [0, 1, 0, '#3fb950'], [0, 0, 1, '#4f8cff']];
    for (const [x, y, z, col] of axes) {
      const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.62, -0.62, -0.62), new THREE.Vector3(-0.62 + x * 1.0, -0.62 + y * 1.0, -0.62 + z * 1.0)]);
      this.cube.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: col })));
    }
    this.scene.add(this.cube);
    this.raycaster = new THREE.Raycaster();
    this.hovered = null;
    this.dark = true;
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => this._hover(e));
    el.addEventListener('pointerleave', () => this._setHover(null));
    el.addEventListener('click', (e) => { const f = this._pick(e); if (f) this.onSelect(f.userData.name); });
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  setTheme(dark) {
    this.dark = dark;
    for (const m of this.faces) { m.material.map.dispose(); m.material.map = labelTexture(m.userData.label, dark, m === this.hovered); }
  }

  resize() {
    const w = this.container.clientWidth || 120, hgt = this.container.clientHeight || 120;
    this.renderer.setSize(w, hgt, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${hgt}px`;
  }

  _pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    const hit = this.raycaster.intersectObjects(this.faces, false)[0];
    return hit ? hit.object : null;
  }

  _hover(e) { this._setHover(this._pick(e)); }

  _setHover(m) {
    if (m === this.hovered) return;
    const prev = this.hovered;
    this.hovered = m;
    for (const f of [prev, m]) if (f) { f.material.map.dispose(); f.material.map = labelTexture(f.userData.label, this.dark, f === m); }
    this.renderer.domElement.style.cursor = m ? 'pointer' : 'default';
    this.dirty = true;
  }

  render(mainCamera, target) {
    const dir = new THREE.Vector3().subVectors(mainCamera.position, target).normalize();
    this.camera.position.copy(dir.multiplyScalar(4));
    this.camera.up.copy(mainCamera.up);
    this.camera.lookAt(0, 0, 0);
    const s = 1.05;
    this.camera.left = -s; this.camera.right = s; this.camera.top = s; this.camera.bottom = -s;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
}
