// Local stand-in for chatgpt.com used by the offline tests. It reproduces the DOM hooks the
// chatgpt-web backend relies on (turn state, response body, generated-image gallery, composer,
// file input) and a few behaviours of the real page (URL becomes /c/<id> after the first prompt,
// history renders after a delay, the tab title follows the prompt).
//
// Prompt keywords: TEXTONLY (text reply), REFUSE (refusal), NEVER (no reply), BLOCK (verification
// interstitial for 3 s), SLOW<n> (reply after n seconds), CLICKSEND (Enter does not send),
// REVOKE (the final image's blob URL is revoked, so saving it fails). Control: signedIn, historyDelayMs,
// blockLoadMs (verification interstitial on page load).

export function fixtureHtml(control) {
  return String.raw`<!doctype html><html><head><title>ChatGPT</title><style>
body{margin:0;font-family:sans-serif} nav{position:fixed;left:0;top:0;width:200px} main{margin-left:220px;padding:10px;padding-bottom:140px}
#composer{position:fixed;bottom:20px;left:260px;width:520px;height:40px;border:1px solid #888} #send{position:fixed;bottom:24px;left:790px;width:32px;height:32px}
#modal{position:fixed;inset:0;background:rgba(0,0,0,.5);display:none} img.gen{width:300px;height:300px}
</style></head><body>
<nav><div>New chat</div><div>Cloudflare tunnel captcha setup</div><div>Can't create images - content policy question</div><div>Just a moment</div></nav>
<main><div id="thread"></div></main>
<div data-composer-attachments id="attachments"></div>
<div id="composer" contenteditable="true" aria-label="Ask anything"></div>
<button id="send" aria-label="Send prompt" data-testid="send-button">^</button>
<input type="file" id="file" accept="image/*" multiple style="display:none">
<div id="modal" role="dialog">Share image</div>
<script>
const CONTROL = ${JSON.stringify(control)};
const thread = document.getElementById("thread"), composer = document.getElementById("composer"), attachments = document.getElementById("attachments");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { localStorage.setItem(k, JSON.stringify(v)); } };
window.modalOpen = false;
window.openModal = () => { window.modalOpen = true; document.getElementById("modal").style.display = "block"; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && window.modalOpen) { window.modalOpen = false; document.getElementById("modal").style.display = "none"; } });
async function pngBlobUrl(size, color) {
  const c = document.createElement("canvas"); c.width = c.height = size; const g = c.getContext("2d"); g.fillStyle = color; g.fillRect(0, 0, size, size);
  const blob = await new Promise((r) => c.toBlob(r, "image/png")); return URL.createObjectURL(blob);
}
function el(html) { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild; }
function conversationId() { const m = /\/c\/([^/?#]+)/.exec(location.pathname); return m ? m[1] : null; }
async function renderAssistantTurn(size, state) {
  const turn = el('<div data-talvt-turn-state="' + state + '"><div data-response-body="x"><div data-testid="generated-image-gallery"></div></div></div>');
  thread.appendChild(turn);
  if (size) { const img = new Image(); img.alt = "Generated image 1"; img.className = "gen"; img.src = await pngBlobUrl(size, "blue"); turn.querySelector("[data-testid=generated-image-gallery]").appendChild(img); }
  return turn;
}
if (CONTROL.blockLoadMs) { const t = document.title; document.title = "Just a moment..."; setTimeout(() => (document.title = t), CONTROL.blockLoadMs); }
(async () => {
  const id = conversationId();
  if (!id) return;
  const turns = store.get("turns:" + id, []);
  if (turns.length === 0) return;
  await sleep(CONTROL.historyDelayMs || 0);
  for (const size of turns) await renderAssistantTurn(size, "complete");
})();
document.getElementById("file").addEventListener("change", (e) => {
  for (const f of e.target.files) { const r = new FileReader(); r.onload = () => { const img = new Image(); img.alt = f.name; img.src = r.result; attachments.appendChild(img); }; r.readAsDataURL(f); }
});
async function send() {
  if (window.modalOpen || document.querySelector('[data-talvt-turn-state="in_progress"]')) return;
  const text = composer.innerText.trim(); if (!text) return;
  composer.innerText = "";
  if (!conversationId()) history.pushState(null, "", "/c/conv-" + Math.random().toString(36).slice(2, 10));
  document.title = text.slice(0, 40);
  const bubble = el('<div data-user-message-bubble="true"></div>'); bubble.textContent = text; thread.appendChild(bubble);
  for (const a of Array.from(attachments.querySelectorAll("img"))) { const u = new Image(); u.alt = "User attachment"; u.className = "gen"; u.src = await pngBlobUrl(400, "green"); bubble.appendChild(u); a.remove(); }
  const turn = el('<div data-talvt-turn-state="in_progress"></div>'); thread.appendChild(turn);
  if (text.includes("NEVER")) return;
  if (text.includes("BLOCK")) { const t = document.title; document.title = "Just a moment..."; await sleep(3000); document.title = t; }
  const slow = /SLOW(\d+)/.exec(text);
  await sleep(slow ? Number(slow[1]) * 1000 : 1000);
  const resp = el('<div data-response-body="x"></div>'); turn.appendChild(resp);
  if (text.includes("TEXTONLY")) { resp.textContent = "Here is a description of the scene instead of an image."; turn.setAttribute("data-talvt-turn-state", "complete"); return; }
  if (text.includes("REFUSE")) { resp.textContent = "I can’t create that image because it may violate our content policies."; turn.setAttribute("data-talvt-turn-state", "complete"); return; }
  const gallery = el('<div data-testid="generated-image-gallery"></div>'); resp.appendChild(gallery);
  const img = new Image(); img.alt = "Generated image 1"; img.className = "gen"; img.src = await pngBlobUrl(512, "red"); gallery.appendChild(img);
  await sleep(2500);
  const counter = store.get("counter", 0) + 1; store.set("counter", counter);
  const size = 900 - counter * 4;
  img.src = await pngBlobUrl(size, "blue");
  if (text.includes("REVOKE")) { await new Promise((r) => (img.complete ? r() : (img.onload = r))); URL.revokeObjectURL(img.src); }
  const id = conversationId(); store.set("turns:" + id, [...store.get("turns:" + id, []), size]);
  await sleep(500);
  turn.setAttribute("data-talvt-turn-state", "complete");
}
composer.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!composer.innerText.includes("CLICKSEND")) send(); } });
document.getElementById("send").addEventListener("click", send);
</script></body></html>`;
}

export async function installFixtureRoutes(context, getControl) {
  await context.route("https://chatgpt.com/**", (route) => {
    const control = getControl();
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/session") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(control.signedIn === false ? {} : { user: { id: "u" } }) });
    }
    return route.fulfill({ contentType: "text/html", body: fixtureHtml(control) });
  });
}

export const pngWidth = (buffer) => buffer.readUInt32BE(16);
