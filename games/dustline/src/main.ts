import { Game } from "./game";
import "./style.css";

const app = document.getElementById("app");
const ui = document.getElementById("ui");
if (!app || !ui) throw new Error("Missing #app or #ui");

try {
  const game = new Game(app, ui);
  game.start();
  (window as unknown as { __dust: unknown }).__dust = { game };
} catch (err) {
  console.error(err);
  ui.innerHTML = `<div class="overlay"><div class="panel">Could not start the game. WebGL is required.<br><small>${String(
    (err as Error)?.message ?? err,
  )}</small></div></div>`;
}
