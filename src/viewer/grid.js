// Anti-aliased, adaptive, "infinite" grid drawn with a shader on a large plane.
import * as THREE from 'three';

const vert = /* glsl */`
  varying vec3 vWorld;
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const frag = /* glsl */`
  uniform float uStep;
  uniform vec3 uColor;
  uniform vec3 uMajor;
  uniform vec3 uAxisX;
  uniform vec3 uAxisY;
  uniform float uFade;
  uniform float uOpacity;
  uniform vec3 uCam;
  varying vec3 vWorld;
  varying vec2 vLocal;
  float line(vec2 p, float s, out float density) {
    vec2 c = p / s;
    vec2 w = fwidth(c);
    density = max(w.x, w.y);
    vec2 g = abs(fract(c - 0.5) - 0.5) / w;
    return 1.0 - min(min(g.x, g.y), 1.0);
  }
  void main() {
    float d1, d2;
    float minor = line(vLocal, uStep, d1);
    float major = line(vLocal, uStep * 10.0, d2);
    minor *= 1.0 - smoothstep(0.1, 0.28, d1);
    major *= 1.0 - smoothstep(0.1, 0.28, d2);
    float dist = distance(uCam, vWorld);
    float fade = 1.0 - smoothstep(uFade * 0.35, uFade, dist);
    vec3 col = mix(uColor, uMajor, step(0.001, major));
    float a = max(minor * 0.45, major * 0.8);
    vec2 aw = fwidth(vLocal) * 1.4;
    float ax = 1.0 - min(abs(vLocal.y) / aw.y, 1.0);
    float ay = 1.0 - min(abs(vLocal.x) / aw.x, 1.0);
    if (ax > 0.0) { col = uAxisX; a = max(a, ax); }
    if (ay > 0.0) { col = uAxisY; a = max(a, ay); }
    a *= fade * uOpacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(col, a);
  }`;

export class Grid {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uStep: { value: 10 },
        uColor: { value: new THREE.Color('#8a92a3') },
        uMajor: { value: new THREE.Color('#6b7385') },
        uAxisX: { value: new THREE.Color('#e5534b') },
        uAxisY: { value: new THREE.Color('#3fb950') },
        uFade: { value: 2000 },
        uOpacity: { value: 0.7 },
        uCam: { value: new THREE.Vector3() },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(200000, 200000), this.material);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.userData.noPick = true;
  }

  setFrame(frame) {
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...frame.xDir), new THREE.Vector3(...frame.yDir), new THREE.Vector3(...frame.normal));
    m.setPosition(new THREE.Vector3(...frame.origin));
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrix.copy(m);
    this.mesh.updateMatrixWorld(true);
  }

  setTheme(dark) {
    const u = this.material.uniforms;
    u.uColor.value.set(dark ? '#5b6272' : '#9aa3b4');
    u.uMajor.value.set(dark ? '#7d8597' : '#7a8396');
    u.uOpacity.value = dark ? 0.55 : 0.75;
  }

  update(camera, viewHeight) {
    const u = this.material.uniforms;
    u.uCam.value.copy(camera.position);
    const step = Math.pow(10, Math.round(Math.log10(Math.max(viewHeight, 1e-3) / 30)));
    u.uStep.value = step;
    u.uFade.value = Math.max(viewHeight * 6, 200);
    return step;
  }
}
