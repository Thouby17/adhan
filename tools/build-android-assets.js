// =====================================================================
// Prépare les fichiers web embarqués dans l'APK.
//
// ⭐ TOUT EST EMBARQUÉ : l'app ne pointe sur AUCUN site. Elle fonctionne
// sans internet, et rien ne peut « casser » à distance.
//
// C'est la différence assumée avec les APK restaurants, qui sont des
// coquilles autour d'un site en ligne : là-bas `server.url` est figé dans
// l'APK, et le jour où le domaine a changé, la chaîne de mise à jour est
// tombée sans un bruit. Ici, il n'y a pas d'URL à figer.
//
//   node tools/build-android-assets.js   →  android-app/www/
// =====================================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src", "app");
const OUT = path.join(ROOT, "android-app", "www");

// La bibliothèque LG n'a aucun sens sur Android.
const SKIP = new Set(["webOSTVjs-1.2.11", "appinfo.json"]);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (SKIP.has(name)) continue;
    const s = path.join(from, name), d = path.join(to, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
copyDir(SRC, OUT);

// index.html référence webOSTV.js : sur Android ce script n'existe pas, et
// l'attribut onerror suffirait — mais autant ne pas embarquer une requête
// vouée à échouer.
const idx = path.join(OUT, "index.html");
let html = fs.readFileSync(idx, "utf8");
html = html.replace(/\s*<script src="webOSTVjs[^>]*><\/script>/g, "");
fs.writeFileSync(idx, html, "utf8");

// Compte rendu
let files = 0, bytes = 0;
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else { files++; bytes += fs.statSync(p).size; }
  }
})(OUT);

console.log("Fichiers embarqués dans l'APK : " + files +
            "  (" + (bytes / 1048576).toFixed(1) + " Mo)");
console.log("  dossier : " + OUT);
if (html.includes("webOSTV")) {
  console.error("  ⚠ référence webOS toujours présente dans index.html");
  process.exit(1);
}
console.log("  aucune référence à un site externe : " +
            (/https?:\/\//.test(html) ? "À VÉRIFIER" : "confirmé"));
