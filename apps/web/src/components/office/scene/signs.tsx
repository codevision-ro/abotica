"use client";

import { useEffect, useState } from "react";
import { CanvasTexture, SRGBColorSpace } from "three";
import type { Cell } from "./layout";
import type { Palette } from "./palette";

/** Letter height band on the wall, in world units. */
const H = 0.34;
const PX = 128;

type Sign = { texture: CanvasTexture; width: number };

/**
 * The place's name as lettering, in the app's font on a transparent canvas: drawn once the web fonts are
 * loaded, so the canvas does not fall back to a system font.
 */
function useSign(text: string, note: string | null, palette: Palette, accent: boolean): Sign | null {
  const [sign, setSign] = useState<Sign | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: CanvasTexture | null = null;
    void document.fonts.ready.then(() => {
      if (cancelled) return;
      const family = getComputedStyle(document.body).fontFamily;
      const canvas = document.createElement("canvas");
      const g = canvas.getContext("2d")!;
      const name = `600 ${PX * 0.44}px ${family}`;
      const small = `400 ${PX * 0.34}px ${family}`;
      g.font = name;
      const nameWidth = g.measureText(text).width;
      g.font = small;
      const noteWidth = note ? g.measureText(note).width + PX * 0.2 : 0;
      const pad = PX * 0.05;
      const dot = accent ? PX * 0.28 : 0;
      canvas.width = Math.ceil(pad * 2 + dot + nameWidth + noteWidth);
      canvas.height = PX;
      g.textBaseline = "middle";
      if (accent) {
        g.fillStyle = palette.folder;
        g.beginPath();
        g.arc(pad + PX * 0.08, PX / 2, PX * 0.08, 0, Math.PI * 2);
        g.fill();
      }
      g.font = name;
      g.fillStyle = palette.dark ? "#d9d9e3" : "#3a3946";
      g.fillText(text, pad + dot, PX / 2 + 2);
      if (note) {
        g.font = small;
        g.fillStyle = palette.dark ? "#9797a1" : "#686872";
        g.fillText(note, pad + dot + nameWidth + PX * 0.2, PX / 2 + 2);
      }
      made = new CanvasTexture(canvas);
      made.colorSpace = SRGBColorSpace;
      made.anisotropy = 8;
      setSign({ texture: made, width: (canvas.width / PX) * H });
    });
    return () => {
      cancelled = true;
      made?.dispose();
    };
  }, [text, note, palette, accent]);
  return sign;
}

/**
 * The place's name lettered on the inside of its back wall, near the left corner. A project room's name
 * opens the project.
 */
export function PlaceSign({
  cell,
  wallHeight,
  wallThickness,
  text,
  note,
  palette,
  onSelect,
}: {
  cell: Cell;
  wallHeight: number;
  wallThickness: number;
  text: string;
  note: string | null;
  palette: Palette;
  onSelect?: () => void;
}) {
  const sign = useSign(text, note, palette, !!onSelect);
  if (!sign) return null;
  const width = Math.min(sign.width, cell.width - 0.6);
  return (
    <group
      position={[cell.x + wallThickness + 0.25 + width / 2, wallHeight - 0.07 - H / 2, cell.z + wallThickness + 0.004]}
    >
      <mesh
        onClick={
          onSelect &&
          ((e) => {
            e.stopPropagation();
            // A drag that ends over it is not a click.
            if (e.delta > 4) return;
            onSelect();
          })
        }
        onPointerOver={onSelect && (() => (document.body.style.cursor = "pointer"))}
        onPointerOut={onSelect && (() => (document.body.style.cursor = ""))}
      >
        <planeGeometry args={[width, H]} />
        <meshBasicMaterial map={sign.texture} transparent alphaTest={0.05} toneMapped={false} />
      </mesh>
    </group>
  );
}
