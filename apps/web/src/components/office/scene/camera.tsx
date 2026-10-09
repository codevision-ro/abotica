"use client";

import { MapControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { type ComponentRef, useCallback, useEffect, useRef } from "react";
import { MOUSE, type OrthographicCamera, TOUCH, Vector3 } from "three";
import type { OfficeLayout, Point } from "./layout";

/** The view: from the front right, about 38 degrees above the floor, never rotated. */
export const VIEW_DIR = new Vector3(
  Math.sin(Math.PI / 4),
  Math.tan((38 * Math.PI) / 180),
  Math.cos(Math.PI / 4),
).normalize();
const DISTANCE = 60;

/** The camera's right and up directions in the world. */
const VIEW_RIGHT = new Vector3(VIEW_DIR.z, 0, -VIEW_DIR.x).normalize();
const VIEW_UP = new Vector3().crossVectors(VIEW_RIGHT, VIEW_DIR.clone().negate()).normalize();

/** Screen up-down as a direction on the floor (left-right is VIEW_RIGHT). */
const SCREEN_Y = new Vector3(-VIEW_DIR.x, 0, -VIEW_DIR.z).normalize();
/** Every button drags the view; the wheel zooms. */
const MOUSE_BUTTONS = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.PAN };
const TOUCHES = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN };

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
  const bounds = useRef(layout.bounds);
  useEffect(() => {
    bounds.current = layout.bounds;
  }, [layout.bounds]);

  // Stable on purpose: drei reconnects the controls whenever these change, and a reconnect in the middle
  // of a drag (any re-render, such as a live refetch) left a pointer pressed for good: dragging and
  // zooming stopped answering.
  const onStart = useCallback(() => {
    touched.current = true;
    glide.current = null;
  }, []);
  const onChange = useCallback(() => {
    const c = controls.current;
    if (!c) return;
    const camera = get().camera;
    const { minX, maxX, minZ, maxZ } = bounds.current;
    // Keep the office in view, along the screen's two directions separately: limits on the floor's own
    // axes are diagonal on screen, and reaching one stopped dragging sideways altogether.
    const center = new Vector3((minX + maxX) / 2, c.target.y, (minZ + maxZ) / 2);
    const offset = c.target.clone().sub(center);
    const corners = [minX, maxX].flatMap((x) => [minZ, maxZ].map((z) => new Vector3(x, 0, z).sub(center)));
    const reach = (axis: Vector3) => Math.max(...corners.map((v) => Math.abs(v.dot(axis))));
    const along = (axis: Vector3) => Math.min(reach(axis), Math.max(-reach(axis), offset.dot(axis)));
    const clamped = center
      .clone()
      .addScaledVector(VIEW_RIGHT, along(VIEW_RIGHT))
      .addScaledVector(SCREEN_Y, along(SCREEN_Y));
    if (clamped.distanceToSquared(c.target) > 1e-8) {
      camera.position.add(clamped.clone().sub(c.target));
      c.target.copy(clamped);
    }
  }, [get]);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const camera = get().camera as OrthographicCamera;
    // Projected size of the office's box seen from the view direction, worked out on the side: moving the
    // camera to measure would throw off a view the user has already moved.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const x of [minX, maxX]) {
      for (const z of [minZ, maxZ]) {
        for (const y of [0, 1.4]) {
          const v = new Vector3(x, y, z);
          xs.push(v.dot(VIEW_RIGHT));
          ys.push(v.dot(VIEW_UP));
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
    const center = new Vector3((minX + maxX) / 2, 0.3, (minZ + maxZ) / 2).addScaledVector(VIEW_RIGHT, panel / 2 / zoom);
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
      mouseButtons={MOUSE_BUTTONS}
      touches={TOUCHES}
      enableDamping
      dampingFactor={0.12}
      zoomSpeed={1.1}
      screenSpacePanning={false}
      onStart={onStart}
      onChange={onChange}
    />
  );
}
