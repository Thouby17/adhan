// =====================================================================
// Fabrique UN SEUL fichier HTML autonome, à copier sur une tablette.
//
// Tout est embarqué : styles, réglages, calcul, interface et le MP3 de
// l'adhan. Le fichier fonctionne SANS internet, sans serveur et sans PC
// allumé — le calcul des horaires est entièrement local.
//
//   npm run tablette      ->  adhan-tablette.html
// =====================================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "src", "app");
const read = f => fs.readFileSync(path.join(APP, f), "utf8");

const CONFIG = require(path.join(APP, "config.js"));
const S = require(path.join(APP, "settings.js"));
const audioPath = path.join(APP, CONFIG.adhanFile);

if (!fs.existsSync(audioPath)) {
  console.error("Fichier audio introuvable : " + audioPath);
  process.exit(1);
}
const audioB64 = fs.readFileSync(audioPath).toString("base64");
const audioURI = "data:" + S.mimeAudio(CONFIG.adhanFile) + ";base64," + audioB64;

// Le corps de index.html, sans les balises <script> (on les réinjecte inline)
// et sans la ligne webOSTV.js (inutile hors TV).
const html = read("index.html");
const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
if (!bodyMatch) { console.error("Structure d'index.html inattendue."); process.exit(1); }
const body = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, "").trim();

// Adaptations pour un écran de tablette (l'original vise un 16/9 de 1920 px).
const RESPONSIVE = `
/* La feuille principale est deja concue pour le mobile : aucun correctif
   supplementaire n'est necessaire dans le build autonome. */
`;

// On force l'adhan embarqué à la place du chemin relatif.
const configSrc = read("config.js").replace(
  /adhanFile:\s*"[^"]*"/,
  'adhanFile: "' + audioURI + '"'
);

const SCRIPTS = `<style>
${read("style.css")}
${RESPONSIVE}
</style>
${body}
<script>
${configSrc}
</script>
<script>
${read("praytimes.js")}
</script>
<script>
${read("settings.js")}
</script>
<script>
${read("native.js")}
</script>
<script>
${read("coran.js")}
</script>
<script>
${read("app.js")}
</script>`;

// --- Fichier autonome, à copier sur une tablette --------------------------
const full = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0c1017">
<title>Adhan — ${CONFIG.placeName || "horaires de prière"}</title>
<!--
  Version autonome, fabriquée par tools/build-standalone.js.
  Fonctionne hors ligne : le calcul des horaires est entièrement local.
-->
</head>
<body>
${SCRIPTS}
</body>
</html>
`;

// --- Variante pour publication en page web (sans l'enveloppe html/head) ---
// L'hôte fournit lui-même <!doctype>, <head> et <body> : on ne livre que le
// contenu, sinon la page se retrouve avec deux <body> imbriqués.
const embed = `<title>Adhan — ${CONFIG.placeName || "horaires de prière"}</title>
${SCRIPTS}
`;

const dest = path.join(ROOT, "adhan-tablette.html");
const destEmbed = path.join(ROOT, "adhan-page.html");
fs.writeFileSync(dest, full, "utf8");
fs.writeFileSync(destEmbed, embed, "utf8");

const mb = b => (Buffer.byteLength(b) / 1048576).toFixed(1);
console.log("Fichier autonome  : " + dest + "  (" + mb(full) + " Mo)");
console.log("Variante page web : " + destEmbed + "  (" + mb(embed) + " Mo)");
console.log("  taille  : " + mb(full) + " Mo (dont l'adhan embarqué)");
console.log("  angles  : " + CONFIG.fajrAngle + "° / " + CONFIG.ishaAngle +
            "°, hautes latitudes " + CONFIG.highLats);
