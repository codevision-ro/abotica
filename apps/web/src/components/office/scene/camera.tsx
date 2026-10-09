"use client";

import { MapControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { type ComponentRef, useEffect, useRef } from "react";
import { type OrthographicCamera, Vector3 } from "three";
import type { OfficeLayout, Point } from "./layout";

/** The view: from the front right, about 38 degrees above the floor, never rotated. */
export const VIEW_DIR = new Vector3(
  Math.sin(Math.PI / 4),
  Math.tan((38 * Math.PI) / 180),
  Math.cos(Math.PI / 4),
).normalize();
const DISTANCE = 60;

/** Room for the feed panel on the right of wide screens, in pixels. */
const PANEL = 340;

/**
 * Fits the whole office on screen at first and whenever the canvas resizes (until the user moves the
 * view), pans on the floor and zooms, and glides to `focus` when it changes.
 */
export function CameraRig({
  layout,
  focus,
  onZoom,
}: {
  layout: OfficeLayout;
  /** A point to look at; `key` changes each time the user asks again. */
  focus: { key: string; at: Point } | null;
  /** Tells the scene how close the view is, relative to the fitted view. */
  onZoom: (ratio: number) => void;
}) {
  const get = useThree((s) => s.get);
  const size = useThree((s) => s.size);
  const controls = useRef<ComponentRef<typeof MapControls>>(null);
  const fit = useRef(1);
  const touched = useRef(false);
  const glide = useRef<{ target: Vector3; zoom: number } | null>(null);
  const lastRatio = useRef(0);

  const { minX, maxX, minZ, maxZ } = layout.bounds;

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const camera = get().camera as OrthographicCamera;
    // Projected size of the office's box seen from the view direction.
    camera.position.copy(VIEW_DIR).multiplyScalar(DISTANCE);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const xs: number[] = [];
    const ys: number[] = [];
    for (const x of [minX, maxX]) {
      for (const z of [minZ, maxZ]) {
        for (const y of [0, 1.4]) {
          const v = new Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse);
          xs.push(v.x);
          ys.push(v.y);
        }
      }
    }
    const panel = size.width > 1000 ? PANEL : 0;
    const w = Math.max(200, size.width - panel - 48);
    const h = Math.max(200, size.height - 64);
    const zoom = Math.min(w / (Math.max(...xs) - Math.min(...xs)), h / (Math.max(...ys) - Math.min(...ys)));
    fit.current = zoom;
    c.minZoom = zoom * 0.6;
    c.maxZoom = Math.max(zoom * 3.5, 130);
    if (touched.current) return;
    // Center the office in the area left of the panel.
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const center = new Vector3((minX + maxX) / 2, 0.3, (minZ + maxZ) / 2).addScaledVector(right, panel / 2 / zoom);
    c.target.copy(center);
    camera.position.copy(center).addScaledVector(VIEW_DIR, DISTANCE);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    c.update();
  }, [get, size.width, size.height, minX, maxX, minZ, maxZ]);

  useEffect(() => {
    if (!focus) return;
    touched.current = true;
    glide.current = {
      target: new Vector3(focus.at.x, 0.3, focus.at.z),
      zoom: Math.max(get().camera.zoom, fit.current * 1.9),
    };
  }, [focus, get]);

  useFrame((state, delta) => {
    const c = controls.current;
    if (!c) return;
    const camera = state.camera as OrthographicCamera;
    const g = glide.current;
    if (g) {
      const k = 1 - Math.exp(-delta * 5);
      c.target.lerp(g.target, k);
      camera.zoom += (g.zoom - camera.zoom) * k;
      camera.position.copy(c.target).addScaledVector(VIEW_DIR, DISTANCE);
      camera.updateProjectionMatrix();
      c.update();
      if (c.target.distanceTo(g.target) < 0.02 && Math.abs(camera.zoom - g.zoom) < 0.5) glide.current = null;
    }
    const ratio = camera.zoom / fit.current;
    if (Math.abs(ratio - lastRatio.current) > 0.05) {
      lastRatio.current = ratio;
      onZoom(ratio);
    }
  });

  return (
    <MapControls
      ref={controls}
      makeDefault
      enableRotate={false}
      enableDamping
      dampingFactor={0.12}
      zoomSpeed={1.1}
      screenSpacePanning={false}
      onStart={() => {
        touched.current = true;
        glide.current = null;
      }}
      onChange={() => {
        const c = controls.current;
        if (!c) return;
        const camera = get().camera;
        // Keep the office in view: the target stays over the floor.
        const clamped = c.target.clone();
        clamped.x = Math.min(maxX + 1, Math.max(minX - 1, clamped.x));
        clamped.z = Math.min(maxZ + 1, Math.max(minZ - 1, clamped.z));
        if (!clamped.equals(c.target)) {
          camera.position.add(clamped.clone().sub(c.target));
          c.target.copy(clamped);
        }
      }}
    />
  );
}
