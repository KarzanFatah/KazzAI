import { Game } from "./game";
import "./style.css";

function boot(): void {
  const container = document.getElementById("app");
  const ui = document.getElementById("ui");
  if (!container || !ui) throw new Error("Missing #app or #ui element");

  try {
    const game = new Game(container, ui);
    game.start();
    // Debug / test hook.
    (window as unknown as { __kazz: unknown }).__kazz = {
      game,
      ctx: game.ctx,
    };
  } catch (err) {
    console.error(err);
    ui.innerHTML = `<div class="fatal">Could not start the game.<br><small>${String(
      (err as Error)?.message ?? err,
    )}</small><br><small>WebGL is required.</small></div>`;
  }
}

boot();
