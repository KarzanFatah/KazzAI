# KAZZ OPS — design spec

A top-down tactical shooter **sandbox**: one soldier, a firing-range arena on a dark navy grid floor,
cover props, physics barrels/crates that react to bullets, explosive barrels, steel pop-up targets.
No enemies, no death. The fun is movement feel, gun feel, and physics chaos.

Visual reference: a phone screenshot of a similar prototype (top-down camera, dark navy floor with a
faint lighter grid, wooden picket fences, orange plastic jersey barriers, off-white concrete jersey
barriers, rusty painted oil barrels in blue / green / rust, a soldier with a white helmet, black
plate carrier, white/grey camo sleeves and a suppressed rifle, yellow tracers, sparks on metal,
wood splinters, a small crosshair, a thin teal stamina bar at the bottom centre, weapon + ammo
top right, a one-line controls hint along the bottom). Build an **original** game in that style.
Do not copy names, logos or branding from the reference.

Tech: TypeScript (strict), Vite, three@0.170, cannon-es@0.20. No other runtime deps. No asset
files: geometry is built from primitives, textures are drawn on canvases, audio is synthesized.
It must run at 60 fps on a mid laptop and be playable on a phone (touch controls).

## Conventions (read `src/types.ts` first)

- Y up, floor at y = 0, metres. Camera yaw 0 looks toward **-Z** → screen-up/W = world -Z, D = +X.
- Facing angle θ ⇒ forward = (sin θ, 0, cos θ). Models face local **+Z**; `root.rotation.y = θ`.
- Player spawns at (0,0,8) facing θ = π (toward -Z / screen top). Main props are north (-Z).
- `ctx: GameContext` is shared. Construction order is documented on `GameContext`; constructors may
  only use systems created before them. Everything else is read during update.
- Tunables live in `ctx.tuning` (see `config.ts`) and are edited live by the F1 panel: **read them
  every frame, never cache**.
- Decoupling: gameplay code emits events on `ctx.events` (see `events.ts`); audio, HUD and camera
  shake listen. Don't call audio directly.
- Physics: `ctx.physics` (see `physics.ts`). Collision groups in `GROUP`. Bullets use
  `ctx.physics.raycast(from, to)` (mask excludes the player and debris). Render dynamic bodies from
  `body.interpolatedPosition / interpolatedQuaternion`. Call `body.wakeUp()` before impulses.
  `applyImpulse(impulse, relativePoint)` takes the point relative to the body centre, world axes.
- Per-frame allocation: avoid `new THREE.Vector3()` in hot paths (reuse module-level temps).
- Shadows: props `castShadow`/`receiveShadow`; keep the shadow camera tight around the player.
- Frame order (see `game.ts`): input.update → touch.update → (tune/camera/reset edges) →
  player.update → physics.step → world.update → player.postPhysics → weapons.update →
  cameraRig.update → world.updateShadowFocus → fx.update → audio.update → hud.update → render →
  input.endFrame.
- Code style: small classes, short comments only where they help, no dead code, no `any` unless
  unavoidable. Prettier default formatting. `npm run typecheck` must pass with zero errors.

## Controls

| Input | Action |
| --- | --- |
| WASD / arrows | move (camera-relative) |
| Shift (hold) | run (drains stamina) |
| Shift double-tap | tactical sprint (fastest, rifle lowered, cannot fire, heavy drain) |
| Space | vault over low cover in front (orange/concrete barriers, sandbags) |
| Ctrl or C | slide when running/sprinting, otherwise toggle crouch |
| RMB (hold) | aim: slower move, tight spread, camera looks ahead toward cursor |
| LMB | fire (hold for auto) |
| R | reload |
| 1 / 2 / 3, wheel | carbine / pistol / shotgun |
| Tab | cycle camera (TOP-DOWN → TACTICAL → CLOSE) |
| F1 | tune panel |
| F9 | reset sandbox |

Touch (phones): left virtual stick = move (push past 85% = run), right virtual stick = aim, and
firing while the right stick is pushed past 60% (auto weapons) / on release-tap (semi weapons are
fine to fire on each push). Buttons: RELOAD, CROUCH/SLIDE, VAULT, SPRINT (tactical), AIM (toggle),
SWAP (next weapon), CAM, RESET. Tune panel button too (gear icon).

## Module specs

### input.ts — `Input`
Keyboard via `window` keydown/keyup using `event.code`. Ignore keys when the event target is an
`input`/`select`/`textarea` (tune panel sliders). `preventDefault` for Tab, F1, F9, Space, arrows,
Ctrl/C combos where possible, and suppress the context menu on the canvas. Mouse via pointer events
on the canvas (also track movement on window so the crosshair follows over UI). Left button fire,
right button aim. Wheel → weaponCycle ±1 (throttled). Double-tap Shift: two Shift keydowns (not
repeats) within 300 ms → `tacticalPressed`. `move` = normalised WASD vector merged with the virtual
stick (whichever is larger). Clear all held state on window blur. `usingTouch` flips true on touch
pointer events and false on mouse movement. `setVirtualMove/Aim/setHeld/trigger` are the touch API.
Edges set by `trigger` and by keys are exposed on the next `update()` and cleared in `endFrame()`
(so an edge is never lost when an event arrives between frames).

### touch.ts — `TouchControls`
Enabled when `matchMedia('(pointer: coarse)')` matches or a touch event happens, or `?touch=1`.
DOM elements inside `ctx.uiRoot` (re-enable `pointer-events` on them). Two floating sticks (appear
where the thumb lands in the left/right half of the lower screen), buttons laid out for both
portrait and landscape, respecting `env(safe-area-inset-*)`. Multi-touch with pointer IDs. Feeds
`ctx.input`. When enabled, hides the keyboard hint bar (HUD checks `ctx.input.usingTouch`).

### hud.ts — `Hud`
DOM overlay in `ctx.uiRoot`, monospace, small caps, subtle shadows. Elements:
- Top-right: weapon name (small, dim) and ammo `27 / 120` (mag big, reserve dim). Turns orange
  when the mag is low, shows `RELOADING` with a thin progress bar while reloading, `NO AMMO`.
- Bottom centre: thin stamina bar (~160 px, teal, turns orange when exhausted) with label
  `STAMINA 100`.
- Bottom: one-line controls hint like the reference
  (`WASD move  SHIFT run  DOUBLE SHIFT tactical  SPACE vault  CTRL/C slide/crouch  RMB aim  LMB fire
  R reload  1-3 weapons  F9 reset  TAB camera  F1 tune`) — hidden on touch.
- Crosshair: DOM element at the pointer (desktop) or at the projected aim point (touch); four ticks
  whose gap grows with `ctx.weapons.spread`; a hit-marker flash on `impact` events that hit a prop,
  stronger on `targetHit`.
- State tag near the stamina bar: CROUCH / SLIDE / TACTICAL / VAULT / AIM.
- Top-left: title `KAZZ OPS` small, camera mode, targets dropped, barrels exploded, FPS (small).
- Toast line (centre-top) for `toast` and `cameraMode` events; fades.
- Start overlay: title, one-line pitch, controls summary (desktop or touch variant), "click / tap
  to start". `dismissIntro()` fades it out. The game runs behind it.

### tune.ts — `TunePanel`
F1 toggles a right-side panel (scrollable, collapsible groups from `TUNE_PARAMS`) with a slider +
numeric value per param (switches for `toggle`). Edits write `ctx.tuning[key]` immediately and are
saved (debounced) with `saveTuning`. Buttons: "Reset defaults" (`resetTuning`), "Close". Works with
touch. Pointer events on the panel must not fire the gun (stopPropagation; the canvas only gets
events that land on it).

### camera.ts — `CameraRig`
Perspective camera following the player with exponential smoothing (`tuning.camFollow`). Three
modes, cycled by `cycleMode()` which emits `cameraMode`:
- `TOP-DOWN`: pitch ≈ 72° down, distance ≈ 24 m, like the reference.
- `TACTICAL`: pitch ≈ 56°, distance ≈ 17 m.
- `CLOSE`: pitch ≈ 42°, distance ≈ 10 m, slight offset behind the player's facing (yaw follows the
  player's facing slowly; movement stays camera-relative via `yaw`).
Distances × `tuning.camDistanceMul`; FOV = `tuning.camFov`. In portrait (aspect < 1) increase the
distance so at least ~14 m of floor is visible horizontally. Aim look-ahead: shift the focus toward
`aimPoint` by `camAimLookAhead` (×2.2 while aiming), clamped to ~8 m. Screen shake with trauma²
(noise-based, decays) × `camShakeMul`; listen to `shot` (small, × weapon.recoilKick × recoilMul) and
`explosion` (by distance). `addKick` gives a short positional kick. Mode changes blend smoothly.
`screenToPlane` = ray/plane intersection; `worldToScreen` = projection to CSS px.

### character.ts — `CharacterModel`
Readable low-poly soldier (~1.8 m) from boxes/cylinders/capsules with flat-ish standard
materials: white/light-grey helmet with dark goggles strap, black plate carrier with grey pouches,
white-grey camo sleeves (canvas texture), dark grey trousers, black boots and gloves, small
backpack. Hierarchy with pivots (hips, spine, head, shoulders/elbows, hips/knees) so it can be
posed. Three weapon meshes (carbine with long suppressor + mag, pistol, pump shotgun) held with
both hands; muzzle/ejection anchors per weapon. Procedural animation:
- legs: walk/run cycle driven by distance travelled, stride scaled by speed; strafing/backpedal
  look sensible because the cycle uses `moveLocal`;
- idle breathing; run lean; tactical sprint = rifle lowered/across chest and stronger lean;
- crouch = hips lowered ~0.45 m, knees bent; crouch-walk;
- slide = lean back, one leg forward, low; vault = tucked legs, hand on obstacle feel;
- aim = rifle shouldered and raised toward forward, head down a little;
- recoil: per shot kick back + up, recovers fast (`shotsFired`);
- reload: tilt rifle, mag hand goes to mag and back (or shell inserts for shotgun) with
  `reloadProgress`; `weaponLowered` lowers the weapon.
All motion smoothed (damped springs / lerps), no popping between states.
`getMuzzle` / `getEjectionPort` return world positions for the active weapon after `update`.

### player.ts — `Player`
- Body: dynamic cannon body, mass 80, `fixedRotation`, `linearDamping` 0, material
  `physics.materials.player`, `collisionFilterGroup = GROUP.PLAYER`, mask = GROUND|STATIC|DYNAMIC.
  Two spheres (r 0.35 at y 0.35 and y 1.05 relative to the body origin at the feet) — use a crouch
  variant (top sphere lower) when crouched/sliding. Add to `ctx.physics`. `allowSleep = false`.
- Each `update`: compute desired horizontal velocity from `ctx.input.move` rotated by
  `ctx.cameraRig.yaw`; speed by state (walk/run/tactical/crouch × aim multiplier); accelerate /
  decelerate toward it; write `body.velocity.x/z` (keep y from physics). This pushes barrels and is
  blocked by static cover.
- Aim point: desktop → camera ray through `input.pointerNdc` raycast against props
  (`ctx.physics.raycast`, BULLET mask, from the camera) — if it hits a prop use the hit point, else
  intersect the plane y = 1.0. Touch → if `input.aimStick` is active, point 9 m from the player in
  that (camera-relative) direction at y = 1.0; otherwise keep facing the movement direction.
  Without pointer activity aim straight ahead.
- Facing turns toward the aim point at `turnRate` (while tactical sprinting or sliding, face the
  movement direction instead).
- States: idle/walk/run/tactical/crouch/crouchWalk/slide/vault. Run while Shift held + moving +
  stamina ok. `tacticalPressed` while moving enters tactical; it ends when movement stops,
  stamina runs out, aim/fire is pressed, crouch/slide, or vault. Exhausted (stamina 0) blocks
  run/tactical until stamina ≥ `staminaRecoverThreshold`; emit `staminaExhausted` once.
- Stamina drains while running/tactical, regenerates after `staminaRegenDelay`; slide and vault cost
  stamina (refuse if not enough).
- Crouch: `crouchPressed` while running/tactical with speed > ~4 → slide (burst at `slideSpeed`
  along the movement direction, decays to crouch speed over `slideDuration`, ends crouched; emit
  `slide`). Otherwise toggles crouch (emit `crouch`).
- Vault: `vaultPressed` → look for a vaultable prop (prop.vaultable with `bounds`) within
  `vaultReach` along the movement direction (or facing if standing). Height (2 × halfExtents.y)
  ≤ `vaultMaxHeight`. Landing spot = past the far side + 0.6 m; refuse if a non-vaultable prop or
  another obstacle occupies it (physics raycast). During the vault switch the body to KINEMATIC
  (collisionResponse off), move it along a smooth arc (up to obstacle top + `vaultArc`) over
  `vaultDuration`, then restore DYNAMIC with the exit velocity. Emit `vault`.
- `canFire()`: false while tactical/vault, and for `sprintToFireDelay` after leaving tactical.
- Explosion knockback: listen to `explosion`; add a decaying horizontal push away from it.
- Footsteps: emit `footstep` every stride (distance-based; louder when running).
- `postPhysics`: copy body position into `position`, set model root, build the
  `CharacterAnimState` (include `ctx.weapons.consumeShotsFired()`, reload state, weapon id) and call
  `model.update`.
- `reset(spawn, yaw)`: teleport body (zero velocity), full stamina, stand up, idle.

### weapon.ts — `WeaponSystem`
Uses `WEAPONS` from `weapons-data.ts`; per-weapon ammo state (mag + reserve) kept when switching.
- Fire when `input.fireHeld` (auto) or `input.firePressed` (semi), `player.canFire()`, not
  reloading (shotgun: firing interrupts a shell reload), cooldown from `fireRate × fireRateMul`.
  Empty mag → `dryFire` event (rate limited) and auto-reload if reserve > 0.
- Spread (deg) = base (`spreadAim` if `player.aiming` else `spreadHip`) + `spreadMoveAdd` ×
  (speed / runSpeed) + bloom; × `crouchMul` when crouched; × `tuning.spreadMul`. Bloom adds
  `bloomPerShot` per shot (cap `bloomMax`) and recovers at `bloomRecovery`/s. Expose `spread`.
- Direction: from the muzzle toward `player.aimPoint`. If the aim point is closer than 1.5 m, use the
  facing direction. Apply random cone spread per pellet.
- Hitscan per pellet: raycast from the player's chest (x/z of the player, y = muzzle y) along the
  pellet direction for `range` (so the muzzle poking through a wall can't shoot through it), using
  `ctx.physics.raycast`. Resolve `prop = world.propFromBody(body)`; surface = prop.surface or
  `ground`. Build `HitInfo`, then `fx.impact(hit, dir)`, `world.applyBulletHit(prop, hit, dir,
  damage × damageMul, impulse × impulseMul)` when there is a prop, emit `impact`, update
  `ctx.stats` (hits = prop hits).
- FX per shot: `fx.muzzleFlash`, `fx.smoke` (suppressed carbine: more smoke, less flash),
  `fx.tracer(muzzle, end)` every `tracerEvery` rounds (each pellet for the shotgun, max 5),
  `fx.shellCasing(ejectionPort, velocity sideways-right + up)`; shotgun ejects on pump.
- Recoil: `ctx.cameraRig.addKick(dir, recoilKick × recoilMul)`; increment shots counter returned by
  `consumeShotsFired()`; emit `shot` (once per trigger pull).
- Reload on `reloadPressed` (or auto when empty): duration `reloadTime / reloadSpeedMul`; emit
  `reloadStart`, `reloadStage` (magOut at 20 %, magIn at 65 %, bolt at 85 %; shotgun: `shell` per
  shell and `pump` at the end), `reloadEnd`. Switching weapons cancels a reload. `infiniteAmmo`
  toggle keeps reserve full.
- Switching (`weaponSlotPressed`, `weaponCycle`): short 0.25 s raise delay; emit `weaponSwitch`;
  call `player.model.setWeapon(id)`.

### fx.ts — `Effects`
All pooled (fixed-size pools, oldest reused), no per-hit allocations. Prefer `InstancedMesh` or
`THREE.Points`/`LineSegments` with `AdditiveBlending` for sparks/tracers.
- `muzzleFlash`: short (≈50 ms) bright star/cone sprite + a `PointLight` (one reused light).
- `tracer`: bright yellow-white streak travelling from muzzle to end fast (≈ 400 m/s visual) with
  a short fading tail.
- `sparks`: yellow/orange streaks with gravity and short life (metal/steel).
- `dust`: soft puffs (grey on concrete, dark-blue-grey on ground, orange-ish on plastic).
- `splinters`: small brown box chips that tumble and bounce (wood), like the reference.
- `smoke`: soft grey puffs from the muzzle that rise and fade.
- `shellCasing`: brass (or red shotgun shell) little cylinders with simple ballistic physics that
  bounce on y = 0 a couple of times and lie there for a few seconds (pool ~40). Emit no events.
- `decal`: dark bullet holes (max ~120, oldest recycled), oriented by normal, slightly offset to
  avoid z-fighting, parented to `attachTo` for dynamic props (convert to its local space).
- `impact`: chooses sparks/dust/splinters/decals by `hit.surface`; steel targets get big sparks.
- `explosion`: fireball (expanding, fading additive sphere/sprites), dark smoke column, debris
  chunks, ground scorch decal, short bright point light.
- `update(dt)` animates everything; `clear()` removes all decals/casings/particles.

### world.ts + textures.ts — `World`
- Floor: large plane with a canvas grid texture (dark navy `#273142`-ish, minor lines every 1 m,
  major lines every 5 m, both subtle), slight roughness; receives shadows. Scene fog matching the
  background for depth. Hemisphere light + one directional "sun" (shadow map 2048, tight frustum
  following the player via `updateShadowFocus`).
- Arena ≈ 60 × 70 m bounded by wooden fences (with gaps/gates). Layout (player starts at (0,0,8)):
  - North (z ≈ -6 … -12), like the reference: a row of wooden picket fence panels behind; in front
    of it an orange plastic barrier pair, three oil barrels (blue, green, rusty) and a concrete
    jersey barrier.
  - A barrel pyramid (3-2-1 stacked) to knock over; a stack of wooden crates; loose barrels around.
  - Explosive red barrels (with hazard stripes) in a small cluster with some crates/barrels nearby
    for chain reactions — away from the spawn.
  - Steel popper targets downrange (north-east), in a row at different distances, on small stands.
  - Vault lane: several low concrete and orange barriers and sandbag walls spaced for vaulting.
  - Some tall concrete walls (not vaultable) for cover; a few traffic cones, pallets, tyre stacks.
- Static props: mass-0 bodies with box (or compound) shapes matching the visuals; group STATIC.
  Fill `bounds` for every static prop. Vaultable: plastic/concrete jersey barriers (h ≈ 0.85-1.0),
  sandbag walls (h ≈ 0.8). Fences are tall (≈ 1.4 m) and not vaultable. Walls ≈ 2.6 m.
- Dynamic props: barrels (cylinder shape, mass `tuning.barrelMass`, a bit of angular damping),
  crates (box, ~25 kg), cones, tyres. Group DYNAMIC. They can sleep. Barrels: three painted
  variants (blue, green, rust) with rusty top lids — canvas textures with rust patches/dents.
- `applyBulletHit`: wake the body, `applyImpulse(dir × impulse, hit.point − body.position)` for
  dynamic props; subtract health. Explosive barrels: on reaching 0 health start a short fuse
  (0.15-0.6 s, flickering emissive + small fire/smoke via fx) then `explode`. Targets: knock the plate
  down (animated hinge rotation), emit `targetHit` with `stats.targetsDropped` incremented, steel
  "ding" handled by audio via the impact surface `steel`, auto-raise after ~3 s.
- `explode(pos, radius, force)`: radial impulse with distance falloff + upward lift to dynamic
  bodies (× `tuning.explosionForce`), damage to explosive barrels within radius (chain with a small
  delay), knock targets, `fx.explosion`, emit `explosion`, `propDestroyed`, increment
  `stats.barrelsExploded`. Remove the exploded barrel (body + mesh; `fx.detachFrom`).
- Collision sounds: listen to `collide` on dynamic bodies; impact velocity → `propCollision`
  (throttle per body, ignore tiny contacts).
- `update(dt)`: sync dynamic meshes from interpolated body transforms, run fuses and target timers,
  respawn barrels that fall below y = -10.
- `reset()`: remove all dynamic and destroyed props and rebuild them at their initial transforms;
  restore targets. Static props can stay.
- `propFromBody`: O(1) map lookup.
- `textures.ts`: grid floor, barrel paint+rust variants, wood planks, concrete, orange plastic,
  hazard stripes, camo, sandbags. Cache textures; reuse materials/geometries across props.

### audio.ts — `AudioSystem`
WebAudio only, synthesized. Lazily create the `AudioContext` in `unlock()`; until then ignore events.
Master gain from `tuning.masterVolume`; a compressor before the destination. Distance attenuation
relative to the player (`ctx.player.position`) and light stereo panning by x offset.
Listen to: `shot` (suppressed carbine = soft thump + filtered noise + mechanical clack; pistol =
sharp crack; shotgun = deep boom + tail), `dryFire` (click), `reloadStage` (mag out/in clicks,
bolt rack, shell insert, pump), `weaponSwitch`, `impact` by surface (metal clang/ping with
resonant pitch, steel bright ding, wood thunk, concrete chip, plastic thock, ground puff, rubber
thud), `propCollision` (barrel bonk/roll by strength), `explosion` (big low boom + crackle tail),
`targetHit`, `footstep` (soft, varied), `vault`, `slide` (whoosh/scrape), `staminaExhausted`
(breath), `cameraMode`/`toast` (tiny UI blip). Cap simultaneous voices; randomize pitch slightly.
Pre-build a few noise buffers once.

## Done criteria
- `npm run typecheck` and `npm run build` pass; `node scripts/smoke.cjs` passes with no page errors.
- Every control in the table works; touch works on a phone viewport.
- Barrels visibly tumble/roll when shot or pushed; explosive barrels chain; targets drop and reset.
- Looks close to the reference style; stays smooth (no per-frame garbage spikes).
