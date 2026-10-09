"use client";

import { RoundedBox } from "@react-three/drei";
import { Block, Board, Chair, Clay, CoffeeCounter, Plant, Pouf, Shelf, Sofa } from "./furniture";
import { type Cell, LOUNGE_SOFAS, type OfficeLayout } from "./layout";
import type { Palette } from "./palette";

export const WALL_H = 0.95;
export const WALL_T = 0.12;
const FLOOR_T = 0.07;

/** The building's floor under every cell; corridors are the space between them. */
export function BaseFloor({ layout, palette: p }: { layout: OfficeLayout; palette: Palette }) {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const m = 0.9;
  const w = maxX - minX + m * 2;
  const d = maxZ - minZ + m * 2;
  return (
    <RoundedBox
      key={`${w},${d}`}
      args={[w, 0.4, d]}
      radius={0.18}
      smoothness={4}
      position={[(minX + maxX) / 2, -0.2, (minZ + maxZ) / 2]}
      receiveShadow
    >
      <Clay color={p.base} rough={0.95} />
    </RoundedBox>
  );
}

/** A cell's floor and its two walls (back and left), open to the corridors on the right and in front. */
export function CellShell({ cell, palette: p, paused = false }: { cell: Cell; palette: Palette; paused?: boolean }) {
  const { x, z, width: w, depth: d } = cell;
  return (
    <group>
      <Block
        size={[w, FLOOR_T, d]}
        position={[x + w / 2, FLOOR_T / 2, z + d / 2]}
        color={paused ? p.floorPaused : p.floor}
        radius={0.03}
      />
      <Block size={[w, WALL_H, WALL_T]} position={[x + w / 2, WALL_H / 2, z + WALL_T / 2]} color={p.wall} radius={0.03} />
      <Block size={[WALL_T, WALL_H, d]} position={[x + WALL_T / 2, WALL_H / 2, z + d / 2]} color={p.wall} radius={0.03} />
      <Block
        size={[w, 0.03, WALL_T + 0.02]}
        position={[x + w / 2, WALL_H + 0.01, z + WALL_T / 2]}
        color={p.wallCap}
        radius={0.012}
      />
      <Block
        size={[WALL_T + 0.02, 0.03, d]}
        position={[x + WALL_T / 2, WALL_H + 0.01, z + d / 2]}
        color={p.wallCap}
        radius={0.012}
      />
    </group>
  );
}

/** A project room: a board behind the manager, a plant in the back corner, a chair at every desk. */
export function RoomDecor({ cell, palette: p }: { cell: Cell; palette: Palette }) {
  const lead = cell.desks.find((d) => d.lead);
  return (
    <group>
      <Board x={lead ? lead.center.x + 1.3 : cell.x + cell.width / 2} z={cell.z + 0.14} palette={p} />
      <Plant position={[cell.x + cell.width - 0.45, FLOOR_T, cell.z + 0.45]} palette={p} />
      <Plant position={[cell.x + 0.42, FLOOR_T, cell.z + cell.depth - 0.42]} palette={p} scale={0.75} />
      {cell.desks.map((d) => (
        <Chair key={d.agentId} spot={d.seat.spot} palette={p} />
      ))}
    </group>
  );
}

/** The super agent's office: a rug under the desk, a shelf and plants. */
export function SuperDecor({ cell, palette: p }: { cell: Cell; palette: Palette }) {
  const desk = cell.desks[0];
  return (
    <group>
      {desk && (
        <>
          <mesh
            position={[desk.center.x, FLOOR_T + 0.004, desk.center.z + 0.35]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <circleGeometry args={[1.15, 48]} />
            <meshStandardMaterial color={p.rug} roughness={1} />
          </mesh>
          <Chair spot={desk.seat.spot} palette={p} />
        </>
      )}
      <Shelf x={cell.x + cell.width - 1.0} z={cell.z + 0.3} palette={p} />
      {/* In the front corner: the back wall carries the office's name. */}
      <Plant position={[cell.x + 0.45, FLOOR_T, cell.z + cell.depth - 0.45]} palette={p} />
    </group>
  );
}

/** The lounge: sofas on a rug, the coffee counter on the left wall, poufs for the rest. */
export function LoungeDecor({ cell, palette: p }: { cell: Cell; palette: Palette }) {
  const poufs = cell.lounge.filter((s) => s.kind === "pouf");
  return (
    <group>
      <mesh position={[cell.x + 3.2, FLOOR_T + 0.004, cell.z + 1.75]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[4.6, 1.9]} />
        <meshStandardMaterial color={p.rug} roughness={1} />
      </mesh>
      {LOUNGE_SOFAS.map((sx) => (
        <Sofa key={sx} x={cell.x + sx} z={cell.z + 0.78} palette={p} />
      ))}
      <Block size={[0.32, 0.36, 0.32]} position={[cell.x + 3.2, 0.25, cell.z + 0.6]} color={p.wood} radius={0.05} />
      <Plant position={[cell.x + 3.2, 0.43, cell.z + 0.6]} palette={p} scale={0.55} />
      <CoffeeCounter x={cell.x + 0.42} z0={cell.z + 2.55} z1={cell.z + 4.15} palette={p} />
      <Plant position={[cell.x + cell.width - 0.45, FLOOR_T, cell.z + 0.45]} palette={p} />
      {poufs.map((s, i) => (
        <Pouf key={i} x={s.seat.spot.x} z={s.seat.spot.z} palette={p} />
      ))}
    </group>
  );
}
