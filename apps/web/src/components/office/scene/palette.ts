import type { OfficeStatus } from "@abotica/core/office";

/**
 * The office's materials, taken from the platform's theme tokens (globals.css, converted to hex since
 * three.js does not read oklch): rooms are cards on the muted floor, violet marks what is active.
 */
export type Palette = {
  dark: boolean;
  base: string;
  baseSide: string;
  floor: string;
  floorPaused: string;
  wall: string;
  wallCap: string;
  deskTop: string;
  deskSide: string;
  chair: string;
  chairBase: string;
  bezel: string;
  leaves: string;
  pot: string;
  sofa: string;
  wood: string;
  counter: string;
  machine: string;
  folder: string;
  paper: string;
  rug: string;
  shadow: number;
  ambient: number;
  sun: number;
  sunColor: string;
  sky: string;
  ground: string;
  status: Record<Exclude<OfficeStatus, "idle">, string>;
};

const LIGHT: Palette = {
  dark: false,
  base: "#e6e6ee",
  baseSide: "#dfdfe8",
  floor: "#ffffff",
  floorPaused: "#f4f4f7",
  wall: "#f8f7fd",
  wallCap: "#e6e4f0",
  deskTop: "#f3f2f8",
  deskSide: "#d9d8e3",
  chair: "#ddd6fc",
  chairBase: "#8f8d9c",
  bezel: "#2b2a33",
  leaves: "#7fb38f",
  pot: "#e8dfd4",
  sofa: "#d9d1fb",
  wood: "#eadfd1",
  counter: "#ececf3",
  machine: "#34333d",
  folder: "#6a49eb",
  paper: "#ffffff",
  rug: "#efeffc",
  shadow: 0.13,
  ambient: 1.35,
  sun: 1.45,
  sunColor: "#ffffff",
  sky: "#ffffff",
  ground: "#d8d6e6",
  status: { working: "#6a49eb", needs_you: "#e49e22", blocked: "#e62b34", waiting: "#8a8a96" },
};

const DARK: Palette = {
  dark: true,
  base: "#1a1a21",
  baseSide: "#121217",
  floor: "#2a2a34",
  floorPaused: "#222229",
  wall: "#34343f",
  wallCap: "#41414e",
  deskTop: "#3d3c49",
  deskSide: "#2f2e39",
  chair: "#3a3363",
  chairBase: "#55546a",
  bezel: "#0c0c10",
  leaves: "#4a8a62",
  pot: "#3b3631",
  sofa: "#3b3470",
  wood: "#3d3730",
  counter: "#2a2a33",
  machine: "#101015",
  folder: "#8f81ff",
  paper: "#e9e8f2",
  rug: "#232232",
  shadow: 0.35,
  ambient: 1.15,
  sun: 0.95,
  sunColor: "#c9c3ff",
  sky: "#6f6aa0",
  ground: "#101016",
  status: { working: "#8f81ff", needs_you: "#f2af48", blocked: "#f75c61", waiting: "#9797a1" },
};

export const paletteFor = (dark: boolean): Palette => (dark ? DARK : LIGHT);
