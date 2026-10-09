"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  type DirectionalLight,
  type Group,
  type HemisphereLight,
  type Mesh,
  type MeshBasicMaterial,
  type PointLight,
  SRGBColorSpace,
} from "three";
import type { Director } from "./director";
import { type Cell, LOUNGE, type OfficeLayout } from "./layout";
import type { Palette } from "./palette";

/**
 * The office's light: daylight from the front left (moonlight in dark mode) with shadows, a lamp over
 * every place that is lit only while someone is in it (dark mode), and the party: the room light goes
 * down, coloured lights sweep every place, sparkles turn on the floors and a disco ball spins over the
 * lounge. Every light stays mounted and only fades, since adding or removing lights recompiles shaders.
 */
export function Lights({
  palette: p,
  layout,
  director,
  party,
}: {
  palette: Palette;
  layout: OfficeLayout;
  director: Director;
  party: boolean;
}) {
  const sun = useRef<DirectionalLight>(null);
  const sky = useRef<HemisphereLight>(null);
  const scene = useThree((s) => s.scene);
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const half = Math.max(maxX - minX, maxZ - minZ) / 2 + 3;

  useEffect(() => {
    const l = sun.current;
    if (!l) return;
    l.target.position.set(cx, 0, cz);
    scene.add(l.target);
    const cam = l.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.updateProjectionMatrix();
    return () => void scene.remove(l.target);
  }, [scene, cx, cz, half]);

  useFrame((_, delta) => {
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 3);
    if (sky.current) sky.current.intensity += ((party ? p.ambient * 0.22 : p.ambient) - sky.current.intensity) * k;
    if (sun.current) sun.current.intensity += ((party ? p.sun * 0.12 : p.sun) - sun.current.intensity) * k;
  });

  return (
    <>
      <hemisphereLight ref={sky} args={[p.sky, p.ground, p.ambient]} />
      <directionalLight
        ref={sun}
        position={[cx - 9, 16, cz + 11]}
        intensity={p.sun}
        color={p.sunColor}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-radius={4}
      />
      {layout.cells.map((cell, i) => (
        <PlaceLights key={cell.key} cell={cell} index={i} palette={p} director={director} party={party} />
      ))}
      <DiscoBall cell={layout.cells.find((c) => c.key === LOUNGE)} party={party} />
    </>
  );
}

const inside = (cell: Cell, x: number, z: number) =>
  x >= cell.x && x <= cell.x + cell.width && z >= cell.z && z <= cell.z + cell.depth;

/** One place's lamp and party light, and the sparkles on its floor. */
function PlaceLights({
  cell,
  index,
  palette: p,
  director,
  party,
}: {
  cell: Cell;
  index: number;
  palette: Palette;
  director: Director;
  party: boolean;
}) {
  const lamp = useRef<PointLight>(null);
  const disco = useRef<PointLight>(null);
  const sparkles = useRef<Mesh>(null);
  const color = useMemo(() => new Color(), []);
  const sparkleTexture = useSparkles();
  const reach = Math.max(cell.width, cell.depth);

  useFrame(({ clock }, delta) => {
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 3);
    const t = clock.elapsedTime;
    if (lamp.current) {
      let someone = false;
      for (const r of director.runtimes.values()) {
        if (r.scale > 0.2 && inside(cell, r.x, r.z)) {
          someone = true;
          break;
        }
      }
      const target = p.roomLight && someone && !party ? p.roomLight.intensity : 0;
      lamp.current.intensity += (target - lamp.current.intensity) * k;
    }
    if (disco.current) {
      disco.current.intensity += ((party ? 16 : 0) - disco.current.intensity) * k;
      color.setHSL((t * 0.12 + index * 0.27) % 1, 1, 0.55);
      disco.current.color.copy(color);
      const a = t * 1.3 + index;
      disco.current.position.set(
        cell.x + cell.width / 2 + Math.cos(a) * cell.width * 0.28,
        2.2,
        cell.z + cell.depth / 2 + Math.sin(a * 0.8) * cell.depth * 0.28,
      );
    }
    if (sparkles.current) {
      sparkles.current.rotation.z = t * 0.35 + index;
      const m = sparkles.current.material as MeshBasicMaterial;
      m.opacity += ((party ? 0.75 : 0) - m.opacity) * k;
      sparkles.current.visible = m.opacity > 0.01;
    }
  });

  return (
    <>
      <pointLight
        ref={lamp}
        position={[cell.x + cell.width / 2, 2.8, cell.z + cell.depth / 2]}
        color={p.roomLight?.color ?? "#ffffff"}
        intensity={0}
        distance={reach * 1.4}
        decay={2}
      />
      <pointLight ref={disco} intensity={0} distance={reach * 1.2} decay={2} />
      <mesh
        ref={sparkles}
        position={[cell.x + cell.width / 2, 0.08, cell.z + cell.depth / 2]}
        rotation={[-Math.PI / 2, 0, 0]}
        visible={false}
      >
        <circleGeometry args={[reach * 0.48, 48]} />
        <meshBasicMaterial
          map={sparkleTexture}
          transparent
          opacity={0}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </>
  );
}

/** Coloured dots on black, added onto the floor: the disco ball's reflections. */
function useSparkles() {
  const texture = useMemo(() => {
    const size = 512;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#000";
    g.fillRect(0, 0, size, size);
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 140; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 2 + rand() * 5;
      const glow = g.createRadialGradient(x, y, 0, x, y, r * 2.5);
      const hue = Math.floor(rand() * 360);
      glow.addColorStop(0, `hsla(${hue}, 100%, 75%, 1)`);
      glow.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
      g.fillStyle = glow;
      g.beginPath();
      g.arc(x, y, r * 2.5, 0, Math.PI * 2);
      g.fill();
    }
    const t = new CanvasTexture(canvas);
    t.colorSpace = SRGBColorSpace;
    return t;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

/** A mirror ball hanging over the lounge, spinning while the party is on. */
function DiscoBall({ cell, party }: { cell: Cell | undefined; party: boolean }) {
  const group = useRef<Group>(null);
  const ball = useRef<Mesh>(null);
  const shown = useRef(0);
  useFrame(({ clock }, delta) => {
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 3);
    shown.current += ((party ? 1 : 0) - shown.current) * k;
    if (group.current) {
      group.current.visible = shown.current > 0.01;
      group.current.scale.setScalar(Math.max(0.001, shown.current));
    }
    if (ball.current) ball.current.rotation.y = clock.elapsedTime * 0.8;
  });
  if (!cell) return null;
  return (
    <group ref={group} position={[cell.x + cell.width / 2, 2.3, cell.z + cell.depth / 2]} visible={false}>
      <mesh position={[0, 0.55, 0]}>
        <cylinderGeometry args={[0.008, 0.008, 0.8, 6]} />
        <meshBasicMaterial color="#888" />
      </mesh>
      <mesh ref={ball} castShadow>
        <icosahedronGeometry args={[0.32, 2]} />
        <meshStandardMaterial color="#e8e8f0" metalness={0.7} roughness={0.18} flatShading emissive="#4a4470" />
      </mesh>
    </group>
  );
}
