// The racing line in 3D, on the web: the tarmac the session's laps used, each lap's line drawn on it (a colour and a
// pattern of its own), its brake, turn-in, apex and throttle points as shapes, the corner numbers over the apexes, and
// one car per lap (the first solid, the others see-through ghosts) placed where the lap was, turned to where the car
// pointed, leaning and pitching as it did, each tyre coloured by its load with a column as tall as the load, and an
// arrow where the car travelled when it slid (|slip| over 1 degree). Three cameras: behind the first car, above it,
// and trackside at the corner it is in; a drag turns the view, the wheel or a pinch zooms, a double tap resets.
//
// three.js is loaded with import() when the view is first drawn, so the rest of the app doesn't carry it.
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View as RNView } from 'react-native';
import type * as ThreeNS from 'three';

import { Text, View } from '@/components/Themed';
import { loadColor, loadShare, ScenePalette } from '@/components/racingline/colors';
import type { CameraMode, SceneProps } from '@/components/racingline/types';
import { Fonts, themed } from '@/constants/Theme';
import { RacingLap, RacingLine, WHEELS } from '@/lib/racingLine';
import {
  indexOf, loadCentre, patternOn, placeCount, placesAt, poseAt, sample, sectionAt, TRACK_M, WHEELBASE_M,
} from '@/lib/racingLineMath';

type Three = typeof ThreeNS;

const DEG = Math.PI / 180;
const LINE_STEP = 0.5; // metres between the points of a lap's line
const LINE_W = 0.34; // a lap's line, metres wide
// a GT4 car: 1.65 m between the tyres' middles, 2.86 m wheelbase (lib/racingLineMath.ts TRACK_M, WHEELBASE_M)
const CAR = { length: 4.5, width: 1.95, wheelR: 0.34, track: TRACK_M / 2, front: -WHEELBASE_M / 2, rear: WHEELBASE_M / 2 };
const TRAIL_STEP = 1; // metres between the points of a load trail
const COLUMN_MAX = 2.2; // a column's height at the top of the load scale, metres

// ---------- building the scene ----------

// the world: x east -> X, y north -> -Z, height -> Y
type V = [number, number, number];

function roadPoint(d: RacingLine, f: number, offset: number, lift: number): V {
  const r = d.road;
  const x = sample(r.x, f) + offset * sample(r.nx, f);
  const y = sample(r.y, f) + offset * sample(r.ny, f);
  const z = r.z ? sample(r.z, f) : 0;
  return [x, z + lift, -y];
}

/** A strip of triangles between two rows of points; segment i is drawn when `on(i)`. */
function strip(T: Three, a: V[], b: V[], on?: (i: number) => boolean) {
  const pos: number[] = [];
  for (let i = 0; i + 1 < a.length; i++) {
    if (on && !on(i)) continue;
    pos.push(...a[i], ...b[i], ...a[i + 1], ...b[i], ...b[i + 1], ...a[i + 1]);
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function flat(T: Three, color: string, extra: Partial<ThreeNS.MeshBasicMaterialParameters> = {}) {
  return new T.MeshBasicMaterial({ color: new T.Color(color), side: T.DoubleSide, ...extra });
}

function tarmac(T: Three, d: RacingLine, pal: ScenePalette) {
  const n = placeCount(d);
  const group = new T.Group();
  const idx = [...Array(n).keys(), 0]; // closed: the last place joins the first
  const L = idx.map((i) => roadPoint(d, i, d.road.left[i], 0));
  const R = idx.map((i) => roadPoint(d, i, d.road.right[i], 0));
  group.add(new T.Mesh(strip(T, L, R), flat(T, pal.tarmac, { polygonOffset: true, polygonOffsetFactor: 2,
    polygonOffsetUnits: 2 })));
  // the edges in ink, 0.25 m wide, so the road reads on any paper
  const edge = flat(T, pal.edge);
  for (const side of [d.road.left, d.road.right]) {
    const sign = side === d.road.left ? 1 : -1;
    const a = idx.map((i) => roadPoint(d, i, side[i], 0.02));
    const b = idx.map((i) => roadPoint(d, i, side[i] - sign * 0.25, 0.02));
    group.add(new T.Mesh(strip(T, a, b), edge));
  }
  // the timing line across the road
  const a = [roadPoint(d, 0, d.road.left[0], 0.03), roadPoint(d, 0.6, d.road.left[0], 0.03)];
  const b = [roadPoint(d, 0, d.road.right[0], 0.03), roadPoint(d, 0.6, d.road.right[0], 0.03)];
  group.add(new T.Mesh(strip(T, a, b), edge));
  // the ground under it all, the paper's colour
  const box = new T.Box3().setFromObject(group);
  const size = box.getSize(new T.Vector3());
  const ground = new T.Mesh(new T.PlaneGeometry(size.x + 400, size.z + 400), flat(T, pal.background));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((box.min.x + box.max.x) / 2, box.min.y - 0.05, (box.min.z + box.max.z) / 2);
  group.add(ground);
  return group;
}

function lapLine(T: Three, d: RacingLine, lap: RacingLap, k: number, color: string) {
  const end = (placeCount(d) - 1) * d.step_m;
  const count = Math.floor(end / LINE_STEP) + 1;
  const a: V[] = [], b: V[] = [];
  const lift = 0.05 + k * 0.012;
  for (let s = 0; s < count; s++) {
    const f = indexOf(d, s * LINE_STEP);
    const lat = sample(lap.lateral, f);
    a.push(roadPoint(d, f, lat + LINE_W / 2, lift));
    b.push(roadPoint(d, f, lat - LINE_W / 2, lift));
  }
  return new T.Mesh(strip(T, a, b, (s) => patternOn(k, s * LINE_STEP)), flat(T, color));
}

// Each tyre's load along the lap: four thin strips on the tarmac, each where that tyre ran (the car's line moved
// half the track left or right, half the wheelbase ahead or behind), coloured by its load and wider with more of it
function loadTrails(T: Three, d: RacingLine, lap: RacingLap, k: number, pal: ScenePalette) {
  const group = new T.Group();
  const end = (placeCount(d) - 1) * d.step_m;
  const count = Math.floor(end / TRAIL_STEP) + 1;
  const lift = 0.07 + k * 0.012;
  for (const w of WHEELS) {
    const side = (w.endsWith('l') ? 1 : -1) * CAR.track; // + left
    const along = w.startsWith('f') ? -CAR.front : -CAR.rear; // + ahead
    const pos: number[] = [];
    const col: number[] = [];
    let prev: { a: V; b: V; c: ThreeNS.Color } | null = null;
    for (let s = 0; s < count; s++) {
      const mm = s * TRAIL_STEP;
      const f = indexOf(d, mm);
      const ft = indexOf(d, Math.max(0, Math.min(end, mm + along)));
      const pct = sample(lap.load[w], f);
      const half = (0.08 + loadShare(pct) * 0.3) / 2;
      const lat = sample(lap.lateral, ft) + side;
      const a = roadPoint(d, ft, lat + half, lift), b = roadPoint(d, ft, lat - half, lift);
      const c = new T.Color(loadColor(pal, pct));
      if (prev) {
        pos.push(...prev.a, ...prev.b, ...a, ...prev.b, ...b, ...a);
        for (const cc of [prev.c, prev.c, c, prev.c, c, c]) col.push(cc.r, cc.g, cc.b);
      }
      prev = { a, b, c };
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    group.add(new T.Mesh(g, new T.MeshBasicMaterial({ vertexColors: true, side: T.DoubleSide })));
  }
  return group;
}

// a marker's shape: brake a cube, turn-in a cone, apex a ball, throttle a diamond
function markerGeometries(T: Three) {
  return {
    brake: new T.BoxGeometry(0.55, 0.55, 0.55),
    turn_in: new T.ConeGeometry(0.4, 0.8, 4),
    apex: new T.SphereGeometry(0.34, 16, 12),
    throttle: new T.OctahedronGeometry(0.42),
  };
}

function markers(T: Three, d: RacingLine, lap: RacingLap, color: string, geo: ReturnType<typeof markerGeometries>,
  pal: ScenePalette) {
  const group = new T.Group();
  const mat = new T.MeshLambertMaterial({ color: new T.Color(color) });
  const outline = new T.LineBasicMaterial({ color: new T.Color(pal.ink) });
  for (const e of lap.events) {
    for (const kind of ['brake', 'turn_in', 'apex', 'throttle'] as const) {
      const m = kind === 'brake' ? e.brake_m : kind === 'turn_in' ? e.turn_in_m : kind === 'apex' ? e.apex_m : e.throttle_m;
      if (m == null || !Number.isFinite(m)) continue;
      const f = indexOf(d, m);
      const p = roadPoint(d, f, sample(lap.lateral, f), 0.45);
      const mesh = new T.Mesh(geo[kind], mat);
      mesh.position.set(...p);
      mesh.userData.m = m;
      const edges = new T.LineSegments(new T.EdgesGeometry(geo[kind]), outline);
      mesh.add(edges);
      group.add(mesh);
    }
  }
  return group;
}

function label(T: Three, text: string, pal: ScenePalette) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = pal.paper;
  ctx.fillRect(8, 8, 240, 112);
  ctx.strokeStyle = pal.ink;
  ctx.lineWidth = 6;
  ctx.strokeRect(8, 8, 240, 112);
  ctx.fillStyle = pal.ink;
  ctx.font = `76px ${Fonts.display}, Anton, Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 68);
  const tex = new T.CanvasTexture(canvas);
  tex.colorSpace = T.SRGBColorSpace;
  const sprite = new T.Sprite(new T.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(7, 3.5, 1);
  sprite.renderOrder = 10;
  return sprite;
}

type CarParts = {
  root: ThreeNS.Group; // placed and turned to the car's heading
  body: ThreeNS.Group; // leaning and pitching
  wheels: Record<string, ThreeNS.MeshLambertMaterial>;
  columns: Record<string, ThreeNS.Mesh>;
  columnMats: Record<string, ThreeNS.MeshBasicMaterial>;
  arrow: ThreeNS.ArrowHelper;
  pads: Record<string, ThreeNS.Mesh>; // seen from above: each tyre as a rectangle in its load's colour
  padMats: Record<string, ThreeNS.MeshBasicMaterial>;
  centre: ThreeNS.Group; // where the total load sits
  above: ThreeNS.Group; // the pads, the centre and the static cross: shown in the views from above
};

// The car points along -Z, its right is +X, up is +Y: a GT car in low polygons, body, cabin, wing and four wheels
function car(T: Three, color: string, ghost: boolean, pal: ScenePalette): CarParts {
  const root = new T.Group();
  const body = new T.Group();
  body.rotation.order = 'YXZ';
  root.add(body);
  const see = ghost ? { transparent: true, opacity: 0.42, depthWrite: false } : {};
  const paint = new T.MeshLambertMaterial({ color: new T.Color(color), ...see });
  const glass = new T.MeshLambertMaterial({ color: new T.Color(pal.scheme === 'dark' ? pal.paper : pal.ink), ...see });
  const add = (geo: ThreeNS.BufferGeometry, mat: ThreeNS.Material, x: number, y: number, z: number) => {
    const m = new T.Mesh(geo, mat);
    m.position.set(x, y, z);
    body.add(m);
    return m;
  };
  add(new T.BoxGeometry(CAR.width, 0.52, CAR.length), paint, 0, 0.56, 0);
  add(new T.BoxGeometry(CAR.width * 0.98, 0.18, 1.1), paint, 0, 0.36, -CAR.length / 2 + 0.3); // the splitter
  add(new T.BoxGeometry(1.5, 0.48, 2.0), glass, 0, 1.06, 0.3); // the cabin
  add(new T.BoxGeometry(1.9, 0.06, 0.38), paint, 0, 1.32, CAR.length / 2 - 0.2); // the wing
  add(new T.BoxGeometry(0.06, 0.4, 0.2), paint, -0.6, 1.1, CAR.length / 2 - 0.2);
  add(new T.BoxGeometry(0.06, 0.4, 0.2), paint, 0.6, 1.1, CAR.length / 2 - 0.2);
  if (!ghost) {
    const edges = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(CAR.width, 0.52, CAR.length)),
      new T.LineBasicMaterial({ color: new T.Color(pal.ink) }));
    edges.position.set(0, 0.56, 0);
    body.add(edges);
  }
  const wheelGeo = new T.CylinderGeometry(CAR.wheelR, CAR.wheelR, 0.32, 18);
  wheelGeo.rotateZ(Math.PI / 2);
  const columnGeo = new T.BoxGeometry(1, 1, 1);
  columnGeo.translate(0, 0.5, 0); // grows up from its foot
  const columnEdges = new T.EdgesGeometry(columnGeo);
  const wheels: CarParts['wheels'] = {};
  const columns: CarParts['columns'] = {};
  const columnMats: CarParts['columnMats'] = {};
  for (const w of WHEELS) {
    const x = (w.endsWith('l') ? -1 : 1) * CAR.track;
    const z = w.startsWith('f') ? CAR.front : CAR.rear;
    const mat = new T.MeshLambertMaterial({ color: new T.Color(pal.ink), ...see });
    wheels[w] = mat;
    const wheel = new T.Mesh(wheelGeo, mat);
    wheel.position.set(x, CAR.wheelR, z);
    root.add(wheel); // wheels stay on the road; the body leans over them
    const cm = new T.MeshBasicMaterial({ color: new T.Color(pal.ink), transparent: true, opacity: ghost ? 0.45 : 0.78,
      depthWrite: false });
    columnMats[w] = cm;
    const col = new T.Mesh(columnGeo, cm);
    col.position.set(x * 1.18, 1.0, z);
    col.add(new T.LineSegments(columnEdges, new T.LineBasicMaterial({ color: new T.Color(pal.ink),
      transparent: ghost, opacity: ghost ? 0.5 : 1 })));
    root.add(col);
    columns[w] = col;
  }
  // the view from above: the tyres as flat rectangles over the car, the load's centre as a dot, a cross at rest
  const above = new T.Group();
  above.position.y = 1.5;
  root.add(above);
  const pads: CarParts['pads'] = {};
  const padMats: CarParts['padMats'] = {};
  const padGeo = new T.PlaneGeometry(1, 1);
  padGeo.rotateX(-Math.PI / 2);
  const padEdges = new T.EdgesGeometry(padGeo);
  for (const w of WHEELS) {
    const pm = new T.MeshBasicMaterial({ color: new T.Color(pal.ink), side: T.DoubleSide, transparent: ghost,
      opacity: ghost ? 0.6 : 1, depthTest: false });
    padMats[w] = pm;
    const pad = new T.Mesh(padGeo, pm);
    pad.position.set((w.endsWith('l') ? -1 : 1) * CAR.track, 0, w.startsWith('f') ? CAR.front : CAR.rear);
    pad.add(new T.LineSegments(padEdges, new T.LineBasicMaterial({ color: new T.Color(pal.ink), depthTest: false })));
    pad.renderOrder = 20;
    above.add(pad);
    pads[w] = pad;
  }
  const inkFlat = (op = 1) => new T.MeshBasicMaterial({ color: new T.Color(pal.ink), transparent: op < 1, opacity: op,
    depthTest: false, side: T.DoubleSide });
  const cross = new T.Group();
  for (const [sx, sz] of [[0.9, 0.06], [0.06, 0.9]]) {
    const bar = new T.Mesh(new T.PlaneGeometry(sx, sz).rotateX(-Math.PI / 2), inkFlat(0.45));
    bar.renderOrder = 21;
    cross.add(bar);
  }
  cross.position.y = 0.01;
  above.add(cross);
  const centre = new T.Group();
  const ring = new T.Mesh(new T.CircleGeometry(0.3, 24).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({
    color: new T.Color(pal.paper), depthTest: false, side: T.DoubleSide }));
  const dot = new T.Mesh(new T.CircleGeometry(0.22, 24).rotateX(-Math.PI / 2), inkFlat());
  ring.renderOrder = 22;
  dot.renderOrder = 23;
  dot.position.y = 0.01;
  centre.add(ring, dot);
  centre.position.y = 0.02;
  above.add(centre);
  above.visible = false;

  const arrow = new T.ArrowHelper(new T.Vector3(0, 0, -1), new T.Vector3(0, 0.62, 0), 6, new T.Color(pal.arrow).getHex(),
    1.2, 0.7);
  arrow.visible = false;
  root.add(arrow);
  return { root, body, wheels, columns, columnMats, arrow, pads, padMats, centre, above };
}

type Built = {
  scene: ThreeNS.Scene;
  marks: ThreeNS.Object3D[]; // every lap's markers, each with its metre (userData.m)
  trails: ThreeNS.Group;
  cars: CarParts[];
  dispose: () => void;
};

function build(T: Three, d: RacingLine, colors: string[], pal: ScenePalette): Built {
  const scene = new T.Scene();
  scene.background = new T.Color(pal.background);
  scene.add(new T.HemisphereLight(0xffffff, pal.scheme === 'dark' ? 0x222222 : 0x777777, 2.2));
  const sun = new T.DirectionalLight(0xffffff, 1.4);
  sun.position.set(80, 200, 60);
  scene.add(sun);
  scene.add(tarmac(T, d, pal));
  const geo = markerGeometries(T);
  const trails = new T.Group();
  const marks: ThreeNS.Object3D[] = [];
  scene.add(trails);
  d.laps.forEach((lap, k) => {
    trails.add(loadTrails(T, d, lap, k, pal));
    const color = colors[k % colors.length];
    scene.add(lapLine(T, d, lap, k, color));
    const mk = markers(T, d, lap, color, geo, pal);
    marks.push(...mk.children);
    scene.add(mk);
  });
  // the corner numbers, as the server gives them, over the reference line at each apex
  for (const c of d.corners.length ? d.corners : d.sections) {
    const s = label(T, c.code, pal);
    s.position.set(...roadPoint(d, indexOf(d, c.apex_m), 0, 5.5));
    scene.add(s);
  }
  const cars = d.laps.map((_, k) => car(T, colors[k % colors.length], k > 0, pal));
  // the ghosts drawn after the solid car, so it shows through them
  cars.forEach((c, k) => {
    c.root.renderOrder = k;
    scene.add(c.root);
  });
  const dispose = () => {
    scene.traverse((o) => {
      const m = o as ThreeNS.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as ThreeNS.Material | ThreeNS.Material[] | undefined;
      for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        (x as ThreeNS.MeshBasicMaterial).map?.dispose();
        x.dispose();
      }
    });
  };
  return { scene, marks, trails, cars, dispose };
}

// ---------- each frame ----------

function placeCars(T: Three, b: Built, d: RacingLine, places: number[], pal: ScenePalette, fromAbove: boolean) {
  d.laps.forEach((lap, k) => {
    const c = b.cars[k];
    const f = places[k];
    const p = poseAt(d, lap, f);
    c.root.position.set(p.x, p.z, -p.y);
    c.root.rotation.y = -p.yaw * DEG;
    c.body.rotation.x = -p.pitch * DEG; // + pitch: the nose down
    c.body.rotation.z = -p.roll * DEG; // + roll: leaning right
    for (const w of WHEELS) {
      const pct = sample(lap.load[w], f);
      const color = loadColor(pal, pct);
      c.wheels[w].color.set(color);
      c.columnMats[w].color.set(color);
      const share = loadShare(pct);
      const col = c.columns[w];
      const width = 0.22 + share * 0.38; // bigger as well as deeper
      col.scale.set(width, 0.05 + share * COLUMN_MAX, width);
      col.visible = !fromAbove;
      c.padMats[w].color.set(color);
      const grow = 0.75 + share * 0.5; // bigger as well as deeper
      c.pads[w].scale.set(0.42 * grow, 1, 0.72 * grow);
    }
    c.above.visible = fromAbove;
    if (fromAbove) {
      const lc = loadCentre({ fl: sample(lap.load.fl, f), fr: sample(lap.load.fr, f), rl: sample(lap.load.rl, f),
        rr: sample(lap.load.rr, f) });
      c.centre.position.set(-lc.left, 0.02, -lc.forward); // the car's right is +X, ahead is -Z
    }
    const slip = p.slip;
    c.arrow.visible = Math.abs(slip) > 1;
    if (c.arrow.visible) c.arrow.setDirection(new T.Vector3(Math.sin(slip * DEG), 0, -Math.cos(slip * DEG)));
  });
}

type Orbit = { az: number; el: number; zoom: number };

function cameraGoal(T: Three, mode: CameraMode, d: RacingLine, lead: ReturnType<typeof poseAt>, m: number,
  orbit: Orbit) {
  const target = new T.Vector3(lead.x, lead.z, -lead.y);
  const yaw = lead.yaw * DEG;
  const ahead = new T.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
  if (mode === 'chase') {
    const dist = 17 * orbit.zoom;
    const el = Math.max(0.05, Math.min(1.35, 0.4 + orbit.el));
    const dir = ahead.clone().applyAxisAngle(new T.Vector3(0, 1, 0), orbit.az);
    const look = target.clone().add(ahead.clone().multiplyScalar(9)).add(new T.Vector3(0, 0.8, 0));
    const pos = target.clone().sub(dir.multiplyScalar(dist * Math.cos(el))).add(new T.Vector3(0, dist * Math.sin(el), 0));
    return { pos, look, up: new T.Vector3(0, 1, 0) };
  }
  if (mode === 'bird') {
    // straight down over the first car, the way it travels up the screen
    const h = 24 * orbit.zoom;
    const up = ahead.clone().applyAxisAngle(new T.Vector3(0, 1, 0), orbit.az);
    return { pos: target.clone().add(new T.Vector3(0, h, 0)), look: target.clone(), up };
  }
  if (mode === 'above') {
    // high and behind, looking down the road ahead
    const dist = 45 * orbit.zoom;
    const el = Math.max(0.5, Math.min(1.45, 0.95 + orbit.el));
    const dir = ahead.clone().applyAxisAngle(new T.Vector3(0, 1, 0), orbit.az);
    const look = target.clone().add(ahead.clone().multiplyScalar(14));
    const pos = target.clone().sub(dir.multiplyScalar(dist * Math.cos(el))).add(new T.Vector3(0, dist * Math.sin(el), 0));
    return { pos, look, up: new T.Vector3(0, 1, 0) };
  }
  // trackside: on the outside of the corner the lead car is in, looking at it
  const s = sectionAt(d.sections, m);
  const apexM = s?.apex_m ?? m;
  const f = indexOf(d, apexM);
  const ref = d.laps[0];
  const inside = Math.sign(sample(ref.lateral, f)) || 1; // the reference lap is nearer the inside at its apex
  const edge = inside > 0 ? d.road.right[Math.round(f)] : d.road.left[Math.round(f)];
  const off = edge - inside * 16;
  const base = roadPoint(d, f, off, 0);
  const centre = roadPoint(d, f, 0, 0);
  const v = new T.Vector3(base[0] - centre[0], 0, base[2] - centre[2]).applyAxisAngle(new T.Vector3(0, 1, 0), orbit.az)
    .multiplyScalar(orbit.zoom);
  const pos = new T.Vector3(centre[0], centre[1], centre[2]).add(v).add(new T.Vector3(0, (5 + orbit.el * 20) * orbit.zoom, 0));
  return { pos, look: target.clone().add(new T.Vector3(0, 0.8, 0)), up: new T.Vector3(0, 1, 0) };
}

// ---------- the component ----------

export function Scene3D({ data, colors, palette, playhead, camera, trails, resetKey, height, label: words }: SceneProps) {
  const styles = useStyles();
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const live = useRef({ data, colors, palette, camera, trails });
  live.current = { data, colors, palette, camera, trails };
  const orbit = useRef<Orbit>({ az: 0, el: 0, zoom: 1 });
  const three = useRef<{ T: Three; renderer: ThreeNS.WebGLRenderer; cam: ThreeNS.PerspectiveCamera } | null>(null);
  const built = useRef<Built | null>(null);
  const smooth = useRef<{ pos: ThreeNS.Vector3; look: ThreeNS.Vector3; up: ThreeNS.Vector3 } | null>(null);

  useEffect(() => {
    orbit.current = { az: 0, el: 0, zoom: 1 };
    smooth.current = null; // straight to the new place
  }, [resetKey, camera]);

  // three.js, the renderer, the gestures and the frame loop: once
  useEffect(() => {
    let stop = false;
    let frame = 0;
    let cleanup = () => {};
    import('three').then((T) => {
      const el = host.current;
      if (stop || !el) return;
      let renderer: ThreeNS.WebGLRenderer;
      try {
        renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      } catch (e) {
        setFailed('This browser can’t draw 3D (WebGL is off).');
        return;
      }
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      const canvas = renderer.domElement;
      canvas.style.display = 'block';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.touchAction = 'none';
      canvas.setAttribute('aria-hidden', 'true');
      el.appendChild(canvas);
      const cam = new T.PerspectiveCamera(50, 1, 0.3, 6000);
      three.current = { T, renderer, cam };
      const size = () => {
        const w = el.clientWidth, h = el.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      };
      size();
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(size) : null;
      ro?.observe(el);

      // the gestures: one pointer turns the view, two pinch, the wheel zooms, a double tap resets
      const pts = new Map<number, { x: number; y: number }>();
      let pinch0 = 0, zoom0 = 1, lastTap = 0;
      const o = () => orbit.current;
      const clampZoom = (z: number) => Math.max(0.25, Math.min(5, z));
      const down = (e: PointerEvent) => {
        canvas.setPointerCapture?.(e.pointerId);
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
          zoom0 = o().zoom;
        }
        if (pts.size === 1 && e.pointerType !== 'mouse') {
          const t = Date.now();
          if (t - lastTap < 320) {
            orbit.current = { az: 0, el: 0, zoom: 1 };
            lastTap = 0;
          } else lastTap = t;
        }
      };
      const move = (e: PointerEvent) => {
        const p = pts.get(e.pointerId);
        if (!p) return;
        const q = { x: e.clientX, y: e.clientY };
        if (pts.size === 1) {
          o().az -= (q.x - p.x) * 0.008;
          o().el = Math.max(-0.3, Math.min(1.0, o().el + (q.y - p.y) * 0.004));
        }
        pts.set(e.pointerId, q);
        if (pts.size === 2 && pinch0 > 10) {
          const [a, b] = [...pts.values()];
          o().zoom = clampZoom(zoom0 * (pinch0 / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y))));
        }
      };
      const up = (e: PointerEvent) => {
        pts.delete(e.pointerId);
        pinch0 = 0;
      };
      const wheel = (e: WheelEvent) => {
        e.preventDefault();
        o().zoom = clampZoom(o().zoom * Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      };
      const dbl = () => {
        orbit.current = { az: 0, el: 0, zoom: 1 };
      };
      canvas.addEventListener('pointerdown', down);
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
      canvas.addEventListener('wheel', wheel, { passive: false });
      canvas.addEventListener('dblclick', dbl);

      let last = performance.now();
      const tick = (now: number) => {
        frame = requestAnimationFrame(tick);
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        const b = built.current;
        const { data: d, camera: mode } = live.current;
        if (!b || !d.laps.length) return;
        const { m, sync } = playhead.current;
        const places = placesAt(d, m, sync);
        b.trails.visible = live.current.trails;
        // behind the chase camera, the markers just passed would fill the view: left out there
        const leadM = places[0] * d.step_m;
        for (const mk of b.marks) {
          const dm = leadM - (mk.userData.m as number);
          mk.visible = mode !== 'chase' || dm < -2 || dm > 40;
        }
        placeCars(T, b, d, places, live.current.palette, mode === 'bird' || mode === 'above');
        const lead = poseAt(d, d.laps[0], places[0]);
        const goal = cameraGoal(T, mode, d, lead, m, orbit.current);
        const s = smooth.current;
        if (!s || s.pos.distanceTo(goal.pos) > 150) {
          smooth.current = { pos: goal.pos.clone(), look: goal.look.clone(), up: goal.up.clone() };
        } else {
          const k = 1 - Math.exp(-dt * (mode === 'trackside' ? 3 : 6));
          s.pos.lerp(goal.pos, k);
          s.look.lerp(goal.look, Math.min(1, k * 1.6));
          s.up.lerp(goal.up, k).normalize();
        }
        const c = smooth.current!;
        cam.position.copy(c.pos);
        cam.up.copy(c.up);
        cam.lookAt(c.look);
        renderer.render(b.scene, cam);
      };
      frame = requestAnimationFrame(tick);
      setReady(true);
      cleanup = () => {
        ro?.disconnect();
        canvas.removeEventListener('pointerdown', down);
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
        canvas.removeEventListener('wheel', wheel);
        canvas.removeEventListener('dblclick', dbl);
        renderer.dispose();
        canvas.remove();
      };
    }, () => setFailed('The 3D view couldn’t be loaded.'));
    return () => {
      stop = true;
      cancelAnimationFrame(frame);
      built.current?.dispose();
      built.current = null;
      cleanup();
      three.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the scene again when the laps or the scheme change
  useEffect(() => {
    const t = three.current;
    if (!ready || !t) return;
    built.current?.dispose();
    built.current = build(t.T, data, colors, palette);
    smooth.current = null;
  }, [ready, data, colors, palette.scheme]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={StyleSheet.flatten([styles.frame, { height }])} accessibilityRole="image" accessibilityLabel={words}>
      <RNView ref={(v: unknown) => {
        host.current = v as HTMLDivElement | null;
      }} style={styles.host} />
      {failed && (
        <View style={styles.over}>
          <Text style={styles.note}>{failed} The charts and the numbers below still follow the scrub bar.</Text>
        </View>
      )}
    </View>
  );
}

const useStyles = themed((c) => ({
  frame: { borderWidth: 1, borderColor: c.rule, backgroundColor: c.background, overflow: 'hidden' },
  host: { flex: 1 },
  over: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'center', padding: 16 },
  note: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 23, color: c.text },
}));
