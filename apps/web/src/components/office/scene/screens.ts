import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";
import type { OfficeActivity } from "@abotica/core/office";
import type { Palette } from "./palette";

/** What a monitor shows: an activity while working, or the state of whoever sits there. */
export type ScreenKind = OfficeActivity | "needs_you" | "blocked" | "waiting" | "off";

/** Screens that scroll while the agent works, in texture heights per second. */
export const SCROLLING: Partial<Record<ScreenKind, number>> = {
  terminal: 0.18,
  writing: 0.05,
  talking: 0.08,
  browser: 0.03,
};

const W = 192;
const H = 120;

/** A screen picture; the scrolling ones are drawn twice as tall and repeat vertically. */
function draw(kind: ScreenKind, p: Palette): HTMLCanvasElement {
  const tall = kind in SCROLLING;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = tall ? H * 2 : H;
  const g = canvas.getContext("2d")!;
  const rand = mulberry(kind.length * 7919);
  const line = (x: number, y: number, w: number, h: number, color: string) => {
    g.fillStyle = color;
    g.beginPath();
    g.roundRect(x, y, w, h, h / 2);
    g.fill();
  };
  switch (kind) {
    case "terminal": {
      g.fillStyle = "#14131b";
      g.fillRect(0, 0, W, canvas.height);
      const colors = ["#7ee2a8", "#b7aaff", "#c9c8d6", "#c9c8d6", "#6f6e80"];
      for (let y = 8; y < canvas.height - 4; y += 11) {
        const indent = Math.floor(rand() * 3) * 10;
        line(10 + indent, y, 20 + rand() * 110, 5, colors[Math.floor(rand() * colors.length)]!);
      }
      break;
    }
    case "browser": {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, W, canvas.height);
      for (let y = 0; y < canvas.height; y += H) {
        g.fillStyle = "#ececf3";
        g.fillRect(0, y, W, 16);
        line(30, y + 5, 120, 6, "#ffffff");
        line(14, y + 26, 90, 9, "#6a49eb");
        g.fillStyle = "#e4e0fb";
        g.beginPath();
        g.roundRect(14, y + 44, 74, 54, 6);
        g.fill();
        for (let i = 0; i < 6; i++) line(98, y + 46 + i * 9, 40 + rand() * 40, 4, "#c9c8d6");
      }
      break;
    }
    case "writing": {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, W, canvas.height);
      for (let y = 10; y < canvas.height - 4; y += 10) {
        const paragraph = rand() < 0.15;
        if (!paragraph) line(18, y, 60 + rand() * 100, 4, "#b9b8c6");
      }
      break;
    }
    case "talking": {
      g.fillStyle = p.dark ? "#1d1d26" : "#f6f5fb";
      g.fillRect(0, 0, W, canvas.height);
      for (let y = 8, mine = false; y < canvas.height - 20; y += 26, mine = !mine) {
        const w = 60 + rand() * 60;
        g.fillStyle = mine ? "#6a49eb" : p.dark ? "#34333f" : "#e4e3ec";
        g.beginPath();
        g.roundRect(mine ? W - w - 12 : 12, y, w, 18, 8);
        g.fill();
      }
      break;
    }
    case "thinking": {
      g.fillStyle = p.dark ? "#1d1d26" : "#f6f5fb";
      g.fillRect(0, 0, W, H);
      for (const [i, c] of ["#6a49eb", "#8f81ff", "#b7aaff"].entries()) {
        g.fillStyle = c;
        g.beginPath();
        g.arc(W / 2 - 24 + i * 24, H / 2, 7, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case "needs_you": {
      g.fillStyle = p.dark ? "#2a2214" : "#fff6e6";
      g.fillRect(0, 0, W, H);
      g.fillStyle = p.dark ? "#3a2f1a" : "#ffffff";
      g.beginPath();
      g.roundRect(30, 22, W - 60, H - 44, 10);
      g.fill();
      line(48, 38, 90, 7, "#e49e22");
      line(48, 54, 70, 5, "#c9c8d6");
      line(48, 76, 40, 12, "#e49e22");
      line(96, 76, 40, 12, p.dark ? "#55505f" : "#e4e3ec");
      break;
    }
    case "blocked": {
      g.fillStyle = p.dark ? "#2a1416" : "#fdeced";
      g.fillRect(0, 0, W, H);
      g.strokeStyle = "#e62b34";
      g.lineWidth = 10;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(W / 2 - 18, H / 2 - 18);
      g.lineTo(W / 2 + 18, H / 2 + 18);
      g.moveTo(W / 2 + 18, H / 2 - 18);
      g.lineTo(W / 2 - 18, H / 2 + 18);
      g.stroke();
      break;
    }
    case "waiting": {
      g.fillStyle = p.dark ? "#1a1a21" : "#f2f2f6";
      g.fillRect(0, 0, W, H);
      g.strokeStyle = "#8a8a96";
      g.lineWidth = 6;
      g.lineCap = "round";
      g.beginPath();
      g.arc(W / 2, H / 2, 26, 0, Math.PI * 2);
      g.moveTo(W / 2, H / 2);
      g.lineTo(W / 2, H / 2 - 16);
      g.moveTo(W / 2, H / 2);
      g.lineTo(W / 2 + 12, H / 2 + 6);
      g.stroke();
      break;
    }
    case "off": {
      g.fillStyle = p.dark ? "#08080b" : "#25242c";
      g.fillRect(0, 0, W, H);
      const shine = g.createLinearGradient(0, 0, W, H);
      shine.addColorStop(0, "rgba(255,255,255,0.10)");
      shine.addColorStop(0.5, "rgba(255,255,255,0)");
      g.fillStyle = shine;
      g.fillRect(0, 0, W, H);
      break;
    }
  }
  return canvas;
}

/** A small seeded random, so every screen of a kind looks the same between renders. */
function mulberry(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS: ScreenKind[] = [
  "terminal",
  "browser",
  "writing",
  "talking",
  "thinking",
  "needs_you",
  "blocked",
  "waiting",
  "off",
];

/** One texture per screen kind, shared by every monitor; the scrolling ones show half their height. */
export function createScreens(p: Palette): Record<ScreenKind, CanvasTexture> {
  return Object.fromEntries(
    KINDS.map((kind) => {
      const texture = new CanvasTexture(draw(kind, p));
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = 4;
      if (kind in SCROLLING) {
        texture.wrapT = RepeatWrapping;
        texture.repeat.set(1, 0.5);
      }
      return [kind, texture];
    }),
  ) as Record<ScreenKind, CanvasTexture>;
}
