# DUSTLINE — design spec

One arcade rally **level** in the desert: a boxy old sedan drifts and jumps along a dirt loop
through sand dunes, past a wooden shack with a wire fence, a windmill water pump, a silver trailer,
telegraph poles with sagging wires, rocks, dry bushes and dead trees, and a stretch along the beach
with a turquoise sea. Three laps against the clock through 8 checkpoints; start/finish under a
wooden truss gantry. Original game (own name, own car, own level) inspired by phone-screenshot
references of a similar prototype: warm sand, long hard shadows, high camera, lots of dust.

Tech: TypeScript strict, Vite, three@0.170. No other runtime deps, no asset files (geometry from
primitives, canvas textures, synthesized audio). Must run smoothly on a phone (instancing, few draw
calls, pooled particles, no per-frame allocations).

## Conventions
- Y up, metres. `terrain.ts`: square `WORLD_SIZE` (520 m) centred on the origin, sea along **-Z**
  (top of the screen), `SEA_LEVEL = 0`. Use `terrain.heightAt(x, z)` / `normalAt` /
  `surfaceAt` / `roadAt` / `shorelineZ(x)`.
- `track.ts`: closed loop; `track.samples` (x, z, y = road height, tangent, s), `track.length`,
  `track.checkpoints` (0 = start/finish), `track.nearest(x, z, out)`; `ROAD_HALF_WIDTH` = 6 m.
- Yaw θ ⇒ forward = (sin θ, 0, cos θ); models face local +Z. Right of tangent (tx, tz) = (-tz, tx).
- Lighting is created by the game: a low warm sun from the south-west (shadow map follows the car,
  ±60 m), hemisphere fill, light haze/fog. Props/effects: `castShadow` / `receiveShadow` where it
  matters (big props cast; tiny scatter may skip).
- Colliders (`types.ts`): circles and capsules in XZ. Nothing **solid** within
  `ROAD_HALF_WIDTH + 2.5` m of the road centre line (soft colliders such as flags are fine).
- Car: ~4.6 m long, ~1.8 m wide. Top speed ~40 m/s; jumps up to ~3 m high.

## Frame order (game.ts)
input → car physics (+ collisions with props) → race/checkpoints → props.update → fx/tracks →
sea.update → camera → audio.update → hud → render.
