import * as THREE from "three";

/**
 * Procedural canvas textures (grid floor, painted rusty barrels, wood, concrete, plastic).
 * STUB: to be implemented by the world builder (see SPEC.md).
 */
export function makeCanvasTexture(
  width: number,
  height: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  draw(g, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
