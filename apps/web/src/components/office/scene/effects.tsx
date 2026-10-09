"use client";

import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Group } from "three";
import type { Director } from "./director";
import { DESK_TOP } from "./furniture";
import type { Palette } from "./palette";

const POOL = 8;

/** Folders that fall on a desk or slide into its drawer and out, drawn from a small pool. */
export function FolderEffects({ director, palette: p }: { director: Director; palette: Palette }) {
  const groups = useRef<(Group | null)[]>([]);
  useFrame(() => {
    const now = performance.now();
    const effects = director.effects.slice(-POOL);
    groups.current.forEach((g, i) => {
      if (!g) return;
      const e = effects[i];
      if (!e) {
        g.visible = false;
        return;
      }
      const t = Math.min(1, Math.max(0, (now - e.start) / e.duration));
      const out = 1 - (1 - t) ** 3;
      g.visible = now - e.start < e.duration + 300;
      // The drawer block sits on the desk's left, toward the person.
      const drawerX = e.at.x - 0.32;
      if (e.kind === "drop") {
        const bounce = t < 1 ? Math.abs(Math.sin(out * Math.PI * 1.5)) * (1 - out) * 0.25 : 0;
        g.position.set(e.at.x - 0.33, DESK_TOP + 0.02 + (1 - out) * 3 + bounce, e.at.z + 0.05);
        g.rotation.set(0, (1 - out) * 4, 0);
      } else {
        const k = e.kind === "drawer" ? out : 1 - out;
        g.position.set(drawerX, DESK_TOP + 0.02 - k * 0.2, e.at.z + 0.05 + k * 0.32);
        g.rotation.set(0, 0.18, 0);
        g.visible = g.visible && k < 0.98;
      }
    });
  });
  return (
    <>
      {Array.from({ length: POOL }, (_, i) => (
        <group key={i} ref={(g) => void (groups.current[i] = g)} visible={false}>
          <mesh castShadow>
            <boxGeometry args={[0.24, 0.025, 0.3]} />
            <meshStandardMaterial color={p.folder} roughness={0.6} />
          </mesh>
          <mesh position={[0, 0.014, 0.02]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.18, 0.2]} />
            <meshStandardMaterial color={p.paper} roughness={0.8} />
          </mesh>
        </group>
      ))}
    </>
  );
}
