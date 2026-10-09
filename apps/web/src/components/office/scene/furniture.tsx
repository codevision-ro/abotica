"use client";

import { RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { CanvasTexture, Mesh } from "three";
import type { Spot } from "./layout";
import type { Palette } from "./palette";

/** Soft matte surfaces, like painted clay. */
export function Clay({ color, rough = 0.85 }: { color: string; rough?: number }) {
  return <meshStandardMaterial color={color} roughness={rough} metalness={0} />;
}

type V3 = [number, number, number];

/** A rounded box resting at `position` (its center), casting and receiving shadows. */
export function Block({
  size,
  position,
  color,
  radius = 0.03,
  rotation,
}: {
  size: V3;
  position: V3;
  color: string;
  radius?: number;
  rotation?: V3;
}) {
  // Keyed by size: drei centers the geometry only when it mounts, so a resized box is built anew.
  return (
    <RoundedBox
      key={size.join(",")}
      args={size}
      radius={Math.min(radius, ...size.map((s) => s / 2.01))}
      smoothness={3}
      position={position}
      rotation={rotation}
      castShadow
      receiveShadow
    >
      <Clay color={color} />
    </RoundedBox>
  );
}

export const DESK_TOP = 0.53;

/**
 * A desk seen from the person's side (they sit at +z): the monitor shows `screen`, a folder lies on it
 * while there is work, and a ring on the floor around the chair carries the status color.
 */
export function Desk({
  x,
  z,
  palette: p,
  screen,
  folder,
  lead,
  ring,
  pulse,
}: {
  x: number;
  z: number;
  palette: Palette;
  screen: CanvasTexture;
  folder: boolean;
  lead: boolean;
  ring: string | null;
  pulse: boolean;
}) {
  const w = lead ? 1.4 : 1.15;
  return (
    <group position={[x, 0, z]}>
      <Block size={[w, 0.06, 0.62]} position={[0, DESK_TOP - 0.03, 0]} color={p.deskTop} radius={0.025} />
      <Block
        size={[0.06, DESK_TOP - 0.06, 0.56]}
        position={[-w / 2 + 0.06, (DESK_TOP - 0.06) / 2, 0]}
        color={p.deskSide}
        radius={0.02}
      />
      <Block
        size={[0.06, DESK_TOP - 0.06, 0.56]}
        position={[w / 2 - 0.06, (DESK_TOP - 0.06) / 2, 0]}
        color={p.deskSide}
        radius={0.02}
      />
      {/* Drawer block on the left, where work put aside goes. */}
      <Block size={[0.32, 0.26, 0.5]} position={[-w / 2 + 0.26, DESK_TOP - 0.2, 0]} color={p.deskSide} radius={0.02} />
      <Monitor palette={p} screen={screen} />
      <Block
        size={[0.42, 0.02, 0.13]}
        position={[0, DESK_TOP + 0.01, 0.13]}
        color={p.dark ? "#3b3a46" : "#e2e1ea"}
        radius={0.008}
      />
      <Block
        size={[0.07, 0.025, 0.1]}
        position={[0.3, DESK_TOP + 0.012, 0.13]}
        color={p.dark ? "#3b3a46" : "#e2e1ea"}
        radius={0.01}
      />
      <mesh position={[w / 2 - 0.17, DESK_TOP + 0.05, -0.12]} castShadow>
        <cylinderGeometry args={[0.04, 0.035, 0.1, 16]} />
        <Clay color={lead ? p.folder : p.paper} rough={0.6} />
      </mesh>
      {folder && (
        <Block
          size={[0.24, 0.025, 0.3]}
          position={[-w / 2 + 0.24, DESK_TOP + 0.012, 0.05]}
          rotation={[0, 0.18, 0]}
          color={p.folder}
          radius={0.008}
        />
      )}
      {lead && <Plant position={[-w / 2 + 0.14, DESK_TOP, -0.16]} palette={p} scale={0.45} />}
      {ring && <StatusRing z={0.55} color={ring} pulse={pulse} />}
    </group>
  );
}

function Monitor({ palette: p, screen }: { palette: Palette; screen: CanvasTexture }) {
  return (
    <group position={[0, DESK_TOP, -0.13]}>
      <mesh position={[0, 0.06, 0]} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 0.12, 12]} />
        <Clay color={p.bezel} />
      </mesh>
      <Block size={[0.2, 0.015, 0.12]} position={[0, 0.008, 0]} color={p.bezel} radius={0.007} />
      <Block size={[0.64, 0.4, 0.04]} position={[0, 0.31, 0]} color={p.bezel} radius={0.02} />
      <mesh position={[0, 0.31, 0.0215]}>
        <planeGeometry args={[0.58, 0.34]} />
        <meshBasicMaterial map={screen} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** A flat ring on the floor in the status color; it breathes when the user is needed. */
function StatusRing({ z, color, pulse }: { z: number; color: string; pulse: boolean }) {
  const mesh = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (!mesh.current) return;
    const s = pulse ? 1 + Math.sin(clock.elapsedTime * 4) * 0.07 : 1;
    mesh.current.scale.set(s, s, 1);
  });
  return (
    <mesh ref={mesh} position={[0, 0.075, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.36, 0.43, 48]} />
      <meshBasicMaterial color={color} transparent opacity={0.75} toneMapped={false} />
    </mesh>
  );
}

/** An office chair at a person's spot; the backrest is behind them. */
export function Chair({ spot, palette: p, low = false }: { spot: Spot; palette: Palette; low?: boolean }) {
  const seat = low ? 0.22 : 0.3;
  return (
    <group position={[spot.x, 0, spot.z]} rotation={[0, spot.yaw, 0]}>
      <mesh position={[0, seat / 2, 0]} castShadow>
        <cylinderGeometry args={[0.03, 0.03, seat, 10]} />
        <Clay color={p.chairBase} />
      </mesh>
      <mesh position={[0, 0.03, 0]} receiveShadow>
        <cylinderGeometry args={[0.2, 0.22, 0.03, 20]} />
        <Clay color={p.chairBase} />
      </mesh>
      <Block size={[0.42, 0.07, 0.4]} position={[0, seat, 0.02]} color={p.chair} radius={0.03} />
      <Block
        size={[0.4, 0.38, 0.07]}
        position={[0, seat + 0.24, -0.2]}
        rotation={[-0.08, 0, 0]}
        color={p.chair}
        radius={0.03}
      />
    </group>
  );
}

export function Plant({ position, palette: p, scale = 1 }: { position: V3; palette: Palette; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.16, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.16, 0.12, 0.32, 20]} />
        <Clay color={p.pot} />
      </mesh>
      {[
        [0, 0.48, 0, 0.2],
        [0.1, 0.62, 0.04, 0.15],
        [-0.09, 0.6, -0.04, 0.14],
        [0.02, 0.76, -0.02, 0.11],
      ].map(([x, y, z, r], i) => (
        <mesh key={i} position={[x!, y!, z!]} castShadow>
          <sphereGeometry args={[r!, 18, 14]} />
          <Clay color={p.leaves} rough={0.95} />
        </mesh>
      ))}
    </group>
  );
}

/** A sofa facing +z, centered at `x`, `z`. */
export function Sofa({ x, z, palette: p }: { x: number; z: number; palette: Palette }) {
  return (
    <group position={[x, 0, z]}>
      <Block size={[1.8, 0.26, 0.72]} position={[0, 0.17, 0]} color={p.sofa} radius={0.08} />
      <Block size={[1.8, 0.42, 0.2]} position={[0, 0.4, -0.28]} color={p.sofa} radius={0.08} />
      <Block size={[0.18, 0.36, 0.72]} position={[-0.86, 0.3, 0]} color={p.sofa} radius={0.07} />
      <Block size={[0.18, 0.36, 0.72]} position={[0.86, 0.3, 0]} color={p.sofa} radius={0.07} />
    </group>
  );
}

export function Pouf({ x, z, palette: p }: { x: number; z: number; palette: Palette }) {
  return (
    <mesh position={[x, 0.12, z]} castShadow receiveShadow>
      <cylinderGeometry args={[0.24, 0.26, 0.2, 24]} />
      <Clay color={p.sofa} />
    </mesh>
  );
}

/** The coffee counter along a left wall, from `z0` to `z1`, with the machine in the middle. */
export function CoffeeCounter({ x, z0, z1, palette: p }: { x: number; z0: number; z1: number; palette: Palette }) {
  const mid = (z0 + z1) / 2;
  return (
    <group>
      <Block size={[0.5, 0.56, z1 - z0]} position={[x, 0.28, mid]} color={p.counter} radius={0.03} />
      <Block size={[0.3, 0.34, 0.28]} position={[x - 0.02, 0.73, mid]} color={p.machine} radius={0.04} />
      <mesh position={[x + 0.1, 0.62, mid]}>
        <boxGeometry args={[0.06, 0.03, 0.08]} />
        <meshBasicMaterial color={p.folder} toneMapped={false} />
      </mesh>
      {[-0.42, 0.42].map((dz) => (
        <mesh key={dz} position={[x, 0.6, mid + dz]} castShadow>
          <cylinderGeometry args={[0.04, 0.035, 0.08, 14]} />
          <Clay color={p.paper} rough={0.6} />
        </mesh>
      ))}
    </group>
  );
}

/** A low bookshelf against a back wall. */
export function Shelf({ x, z, palette: p }: { x: number; z: number; palette: Palette }) {
  const books = ["#c8bdf9", p.folder, "#f2c48d", "#9fd3b4", "#d8d6e3", "#f4a6a9"];
  return (
    <group position={[x, 0, z]}>
      <Block size={[1.1, 0.7, 0.3]} position={[0, 0.35, 0]} color={p.deskSide} radius={0.03} />
      {books.map((c, i) => (
        <Block
          key={i}
          size={[0.1, 0.22 + (i % 3) * 0.03, 0.2]}
          position={[-0.4 + i * 0.15, 0.82 + (i % 3) * 0.015, 0]}
          color={c}
          radius={0.015}
        />
      ))}
    </group>
  );
}

/** A board on a back wall, with sticky notes. */
export function Board({ x, z, palette: p }: { x: number; z: number; palette: Palette }) {
  return (
    <group position={[x, 0, z]}>
      <Block size={[1.2, 0.5, 0.04]} position={[0, 0.98, 0]} color={p.dark ? "#2f2f3a" : "#ffffff"} radius={0.02} />
      {["#f2c48d", "#c8bdf9", "#9fd3b4", "#f4a6a9", "#c8bdf9"].map((c, i) => (
        <mesh key={i} position={[-0.42 + i * 0.21, 0.98 + (i % 2 ? 0.08 : -0.06), 0.025]}>
          <planeGeometry args={[0.14, 0.14]} />
          <meshStandardMaterial color={c} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}
