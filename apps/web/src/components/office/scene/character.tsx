"use client";

import type { OfficeActivity, OfficeStatus } from "@abotica/core/office";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Group } from "three";
import type { Director } from "./director";
import { Clay } from "./furniture";

/**
 * A person in clay: body in the agent's color, head in its avatar background, built from a few rounded
 * shapes and moved by hand every frame (sitting and typing, walking, talking, on the phone).
 */

const LEG = 0.3;
const HIP_STAND = 0.37;
const HIP_SEAT: Record<string, number> = { desk: 0.36, sofa: 0.36, pouf: 0.3, stand: HIP_STAND };

type Joints = {
  root: Group | null;
  hips: Group | null;
  torso: Group | null;
  head: Group | null;
  armL: Group | null;
  armR: Group | null;
  legL: Group | null;
  legR: Group | null;
  folder: Group | null;
  phone: Group | null;
  cup: Group | null;
};

/** Target angles of a pose; every frame eases the joints towards them. */
type Target = {
  hip: number;
  lean: number;
  headX: number;
  headY: number;
  armL: [number, number];
  armR: [number, number];
  legL: number;
  legR: number;
};

const ease = (from: number, to: number, k: number) => from + (to - from) * k;

export function Character({
  runtimeKey,
  director,
  color,
  skin,
  folder,
  status,
  activity,
  seed,
  onSelect,
}: {
  runtimeKey: string;
  director: Director;
  color: string;
  skin: string;
  /** The color of the folder they carry. */
  folder: string;
  status: OfficeStatus;
  activity: OfficeActivity | null;
  /** Varies idle timing between people. */
  seed: number;
  onSelect: () => void;
}) {
  const j = useRef<Joints>({
    root: null,
    hips: null,
    torso: null,
    head: null,
    armL: null,
    armR: null,
    legL: null,
    legR: null,
    folder: null,
    phone: null,
    cup: null,
  }).current;

  useFrame(({ clock }, delta) => {
    const r = director.runtimes.get(runtimeKey);
    if (!r || !j.root || !j.hips || !j.torso || !j.head || !j.armL || !j.armR || !j.legL || !j.legR) return;
    const t = clock.elapsedTime + seed * 7.3;
    const now = performance.now();
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 12);
    j.root.position.set(r.x, 0, r.z);
    j.root.rotation.y = r.yaw;
    j.root.scale.setScalar(Math.max(0.001, r.scale));

    const seated = r.act === "home" && r.home.pose !== "stand";
    const phone = r.phoneUntil > now;
    const target: Target = {
      hip: seated ? HIP_SEAT[r.home.pose]! : HIP_STAND,
      lean: 0,
      headX: 0,
      headY: 0,
      armL: [0.05, 0.08],
      armR: [0.05, -0.08],
      legL: seated ? -Math.PI / 2 : 0,
      legR: seated ? -Math.PI / 2 : 0,
    };
    let showCup = false;

    if (r.act === "walk") {
      const s = Math.sin(t * 10);
      target.legL = s * 0.55;
      target.legR = -s * 0.55;
      target.armL = [-s * 0.45, 0.1];
      target.armR = [s * 0.45, -0.1];
      target.hip = HIP_STAND + Math.abs(Math.cos(t * 10)) * 0.03;
      if (r.carry) {
        target.armL = [-1.1, -0.35];
        target.armR = [-1.1, 0.35];
      }
    } else if (r.act === "talk") {
      target.armR = [-0.9 + Math.sin(t * 3.2) * 0.25, -0.25];
      target.armL = [-0.35 + Math.sin(t * 2.1 + 1) * 0.15, 0.15];
      target.headX = Math.sin(t * 2.5) * 0.05;
    } else if (r.home.pose === "desk") {
      if (status === "working") {
        if (activity === "thinking") {
          target.armR = [-2.15, 0.45];
          target.armL = [-1.25, 0.2];
          target.headX = 0.12;
          target.headY = Math.sin(t * 0.6) * 0.15;
        } else if (activity === "browser") {
          target.armR = [-1.3, -0.05 + Math.sin(t * 1.7) * 0.06];
          target.armL = [-0.9, 0.2];
          target.headY = Math.sin(t * 0.9) * 0.08;
        } else {
          // Typing: both hands on the keyboard, alternating.
          target.armL = [-1.3 + Math.sin(t * 16) * 0.07, -0.12];
          target.armR = [-1.3 + Math.sin(t * 16 + 1.7) * 0.07, 0.12];
          target.headX = 0.06 + Math.sin(t * 1.3) * 0.03;
        }
      } else if (status === "blocked") {
        target.armL = [-2.75, -0.45];
        target.armR = [-2.75, 0.45];
        target.headX = 0.3;
        target.headY = Math.sin(t * 1.5) * 0.2;
        target.lean = 0.12;
      } else if (status === "needs_you") {
        // Turned to the room, waving every few seconds.
        const wave = Math.sin(t * 0.9) > 0.2;
        target.armR = wave ? [-2.9, -0.2 + Math.sin(t * 9) * 0.3] : [-1.2, -0.2];
        target.armL = [-1.2, 0.2];
        target.headY = 0.6;
      } else if (status === "waiting") {
        target.armL = [-1.25, -1.0];
        target.armR = [-1.25, 1.0];
        target.lean = -0.14;
        target.headY = Math.sin(t * 0.5) > 0.6 ? 0.7 : 0;
        target.headX = -0.05;
      } else {
        target.lean = -0.12;
        target.armL = [-0.5, 0.1];
        target.armR = [-0.5, -0.1];
      }
    } else {
      // Lounge: relaxed, with a coffee now and then.
      showCup = true;
      const sip = Math.sin(t * 0.45) > 0.85;
      target.armR = sip ? [-2.3, 0.35] : [seated ? -0.75 : -0.9, -0.2];
      target.armL = [seated ? -0.45 : 0.05, 0.12];
      target.headX = sip ? -0.2 : 0;
      target.headY = Math.sin(t * 0.35) * 0.35;
      target.lean = seated ? -0.08 : 0;
    }

    if (phone) {
      target.armR = [-2.6, 0.15];
      target.headX = 0.08;
      target.headY = -0.25;
      showCup = false;
    }
    if (r.lookAt && r.act === "home") {
      const yaw = Math.atan2(r.lookAt.x - r.x, r.lookAt.z - r.z) - r.yaw;
      target.headY = Math.max(-1.1, Math.min(1.1, Math.atan2(Math.sin(yaw), Math.cos(yaw))));
    }

    j.hips.position.y = ease(j.hips.position.y, target.hip + Math.sin(t * 1.8) * 0.004, k);
    j.torso.rotation.x = ease(j.torso.rotation.x, target.lean, k);
    j.head.rotation.x = ease(j.head.rotation.x, target.headX, k);
    j.head.rotation.y = ease(j.head.rotation.y, target.headY, k * 0.6);
    j.armL.rotation.x = ease(j.armL.rotation.x, target.armL[0], k);
    j.armL.rotation.z = ease(j.armL.rotation.z, target.armL[1], k);
    j.armR.rotation.x = ease(j.armR.rotation.x, target.armR[0], k);
    j.armR.rotation.z = ease(j.armR.rotation.z, target.armR[1], k);
    j.legL.rotation.x = ease(j.legL.rotation.x, target.legL, k);
    j.legR.rotation.x = ease(j.legR.rotation.x, target.legR, k);
    if (j.folder) j.folder.visible = r.act === "walk" && r.carry;
    if (j.phone) j.phone.visible = phone;
    if (j.cup) j.cup.visible = showCup && !(r.act === "walk");
  });

  return (
    <group ref={(g) => void (j.root = g)}>
      <group ref={(g) => void (j.hips = g)} position={[0, HIP_STAND, 0]}>
        <group
          ref={(g) => void (j.torso = g)}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => (document.body.style.cursor = "")}
        >
          <mesh position={[0, 0.2, 0]} castShadow>
            <capsuleGeometry args={[0.17, 0.16, 6, 16]} />
            <Clay color={color} rough={0.7} />
          </mesh>
          <group ref={(g) => void (j.head = g)} position={[0, 0.56, 0]}>
            <mesh castShadow>
              <sphereGeometry args={[0.165, 24, 18]} />
              <Clay color={skin} rough={0.75} />
            </mesh>
            {[-0.06, 0.06].map((x) => (
              <mesh key={x} position={[x, 0.02, 0.152]}>
                <sphereGeometry args={[0.02, 10, 8]} />
                <meshStandardMaterial color="#1e1d26" roughness={0.3} />
              </mesh>
            ))}
            <group ref={(g) => void (j.phone = g)} position={[-0.17, -0.02, 0.02]} visible={false}>
              <mesh>
                <boxGeometry args={[0.04, 0.16, 0.08]} />
                <meshStandardMaterial color="#25242c" roughness={0.4} />
              </mesh>
            </group>
          </group>
          {(["armL", "armR"] as const).map((side) => (
            <group key={side} ref={(g) => void (j[side] = g)} position={[side === "armL" ? 0.21 : -0.21, 0.33, 0]}>
              <mesh position={[0, -0.13, 0]} castShadow>
                <capsuleGeometry args={[0.05, 0.16, 4, 10]} />
                <Clay color={color} rough={0.7} />
              </mesh>
              <mesh position={[0, -0.28, 0]}>
                <sphereGeometry args={[0.055, 12, 10]} />
                <Clay color={skin} rough={0.75} />
              </mesh>
              {side === "armR" && (
                <group ref={(g) => void (j.cup = g)} position={[0, -0.32, 0.04]} visible={false}>
                  <mesh>
                    <cylinderGeometry args={[0.04, 0.035, 0.08, 12]} />
                    <Clay color="#ffffff" rough={0.5} />
                  </mesh>
                </group>
              )}
            </group>
          ))}
          <group ref={(g) => void (j.folder = g)} position={[0, 0.3, 0.27]} rotation={[0.2, 0, 0]} visible={false}>
            <mesh castShadow>
              <boxGeometry args={[0.26, 0.2, 0.03]} />
              <meshStandardMaterial color={folder} roughness={0.6} />
            </mesh>
            <mesh position={[0, 0.02, 0.017]}>
              <planeGeometry args={[0.2, 0.12]} />
              <meshStandardMaterial color="#ffffff" roughness={0.8} />
            </mesh>
          </group>
        </group>
        {(["legL", "legR"] as const).map((side) => (
          <group key={side} ref={(g) => void (j[side] = g)} position={[side === "legL" ? 0.085 : -0.085, 0.02, 0]}>
            <mesh position={[0, -LEG / 2 + 0.03, 0]} castShadow>
              <capsuleGeometry args={[0.065, LEG - 0.12, 4, 10]} />
              <Clay color={color} rough={0.75} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}
