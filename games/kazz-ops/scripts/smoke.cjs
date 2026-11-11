#!/usr/bin/env node
/*
 * Headless smoke test: boots the game in Chromium (SwiftShader WebGL), plays a short scripted
 * session with real keyboard/mouse input, saves screenshots to test-output/ and prints a JSON
 * report. Exit code 1 on page errors or failed checks.
 *
 *   node scripts/smoke.cjs                  # starts its own vite dev server
 *   node scripts/smoke.cjs --url http://localhost:5173/
 *   node scripts/smoke.cjs --mobile-only    # only the phone (touch) pass
 *   SMOKE_PORT=5201 SMOKE_OUT=/tmp/out node scripts/smoke.cjs   # parallel-safe
 */
const { chromium, devices } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const OUT = process.env.SMOKE_OUT || path.join(ROOT, "test-output");
const argv = process.argv.slice(2);
const urlArg = argv.includes("--url") ? argv[argv.indexOf("--url") + 1] : null;
const mobileOnly = argv.includes("--mobile-only");
const PORT = Number(process.env.SMOKE_PORT || 5199);

const LAUNCH_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--autoplay-policy=no-user-gesture-required",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const proc = spawn(
    process.execPath,
    [
      path.join(ROOT, "node_modules/vite/bin/vite.js"),
      "--port",
      String(PORT),
      "--strictPort",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (log.includes("Local:")) return proc;
    await sleep(100);
  }
  proc.kill();
  throw new Error("vite did not start:\n" + log);
}

function collectErrors(page, errors) {
  page.on("pageerror", (e) => errors.push("pageerror: " + (e.stack || e.message)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console.error: " + m.text());
  });
}

async function snap(page, name) {
  const file = path.join(OUT, name + ".png");
  await page.screenshot({ path: file });
  return file;
}

const state = (page) =>
  page.evaluate(() => {
    const k = window.__kazz;
    if (!k) return null;
    const c = k.ctx;
    const dyn = c.world.props.filter((p) => p.dynamic && p.body);
    return {
      player: {
        x: +c.player.position.x.toFixed(2),
        z: +c.player.position.z.toFixed(2),
        state: c.player.state,
        stamina: Math.round(c.player.stamina),
        crouched: c.player.crouched,
      },
      weapon: {
        id: c.weapons.current.id,
        ammo: c.weapons.ammo,
        reserve: c.weapons.reserve,
        reloading: c.weapons.reloading,
      },
      camera: c.cameraRig.modeName,
      stats: { ...c.stats },
      props: c.world.props.length,
      dynamicProps: dyn.length,
      dynamicSignature: dyn
        .slice(0, 40)
        .reduce(
          (s, p) => s + Math.abs(p.body.position.x) + Math.abs(p.body.position.z) + Math.abs(p.body.quaternion.x),
          0,
        ),
      tuneVisible: k.game.tunePanel.visible,
      touchEnabled: k.game.touch.enabled,
      sceneChildren: c.scene.children.length,
    };
  });

async function desktopPass(browser, base, report, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  collectErrors(page, errors);
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__kazz, null, { timeout: 20000 });
  await sleep(1500);
  report.screens.push(await snap(page, "01-intro"));
  report.initial = await state(page);

  // Dismiss intro and aim toward the top of the screen (north, where the barrels are).
  await page.mouse.move(640, 400);
  await page.mouse.click(640, 400);
  await sleep(300);
  await page.mouse.move(640, 180, { steps: 5 });
  await sleep(500);
  report.screens.push(await snap(page, "02-aim"));

  // Fire a burst.
  await page.mouse.down();
  await sleep(700);
  report.screens.push(await snap(page, "03-firing"));
  await sleep(900);
  await page.mouse.up();
  await sleep(600);
  report.afterFire = await state(page);
  report.screens.push(await snap(page, "04-after-fire"));

  // Walk forward, then run.
  await page.keyboard.down("KeyW");
  await sleep(900);
  await page.keyboard.down("ShiftLeft");
  await sleep(900);
  report.running = await state(page);
  await page.keyboard.up("ShiftLeft");
  await page.keyboard.up("KeyW");
  await sleep(300);
  report.afterMove = await state(page);
  report.screens.push(await snap(page, "05-after-move"));

  // Crouch toggle.
  await page.keyboard.press("KeyC");
  await sleep(300);
  report.crouch = await state(page);
  await page.keyboard.press("KeyC");

  // Reload.
  await page.keyboard.press("KeyR");
  await sleep(200);
  report.reload = await state(page);

  // Weapon switch to shotgun and fire once.
  await page.keyboard.press("Digit3");
  await sleep(500);
  await page.mouse.click(640, 180);
  await sleep(600);
  report.shotgun = await state(page);
  report.screens.push(await snap(page, "06-shotgun"));

  // Camera cycle.
  await page.keyboard.press("Tab");
  await sleep(800);
  report.camera2 = await state(page);
  report.screens.push(await snap(page, "07-camera-2"));
  await page.keyboard.press("Tab");
  await sleep(800);
  report.screens.push(await snap(page, "08-camera-3"));
  await page.keyboard.press("Tab");
  await sleep(300);

  // Tune panel.
  await page.keyboard.press("F1");
  await sleep(400);
  report.tune = await state(page);
  report.screens.push(await snap(page, "09-tune"));
  await page.keyboard.press("F1");
  await sleep(200);

  // Reset.
  await page.keyboard.press("F9");
  await sleep(600);
  report.afterReset = await state(page);
  report.screens.push(await snap(page, "10-after-reset"));

  // Deterministic simulation check: 3 seconds of game time must not throw.
  await page.evaluate(() => window.__kazz.game.advance(3));
  report.afterAdvance = await state(page);
  await page.close();
}

async function mobilePass(browser, base, report, errors) {
  const context = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await context.newPage();
  collectErrors(page, errors);
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__kazz, null, { timeout: 20000 });
  await sleep(1200);
  const vp = page.viewportSize();
  await page.touchscreen.tap(vp.width / 2, vp.height / 2);
  await sleep(800);
  report.mobile = await state(page);
  report.screens.push(await snap(page, "11-mobile"));
  await context.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let server = null;
  const base = urlArg || `http://localhost:${PORT}/`;
  if (!urlArg) server = await startServer();
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const errors = [];
  const report = { screens: [] };
  try {
    if (!mobileOnly) await desktopPass(browser, base, report, errors);
    await mobilePass(browser, base, report, errors);
  } catch (e) {
    errors.push("smoke script: " + (e.stack || e.message));
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  const checks = [];
  const check = (name, ok) => checks.push({ name, ok: !!ok });
  if (!mobileOnly) {
    check("game booted", report.initial);
    check("props exist", report.initial && report.initial.props > 10);
    check("shots fired", report.afterFire && report.afterFire.stats.shots > 0);
    check("ammo consumed", report.afterFire && report.afterFire.weapon.ammo < 30);
    check(
      "physics props moved when shot",
      report.initial && report.afterFire && Math.abs(report.afterFire.dynamicSignature - report.initial.dynamicSignature) > 0.01,
    );
    check(
      "player moved",
      report.initial && report.afterMove && Math.hypot(report.afterMove.player.x - report.initial.player.x, report.afterMove.player.z - report.initial.player.z) > 1,
    );
    check("stamina drained while running", report.running && report.running.player.stamina < 100);
    check("crouch toggles", report.crouch && report.crouch.player.crouched);
    check("weapon switched", report.shotgun && report.shotgun.weapon.id === "shotgun");
    check("camera mode cycles", report.camera2 && report.initial && report.camera2.camera !== report.initial.camera);
    check("tune panel opens", report.tune && report.tune.tuneVisible);
    check("reset restores ammo", report.afterReset && report.afterReset.weapon.id === "carbine" && report.afterReset.weapon.ammo === 30);
  }
  check("touch controls on phone", report.mobile && report.mobile.touchEnabled);
  check("no page errors", errors.length === 0);

  const out = { checks, errors, report };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ checks, errors: errors.slice(0, 20) }, null, 2));
  console.log("Screenshots + report.json in " + OUT);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
})();
