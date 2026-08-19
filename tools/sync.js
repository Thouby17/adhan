// Recopie les fichiers canoniques de src/app vers src/service.
//
// webOS empaquette l'interface et le service séparément : ils ne peuvent pas
// partager un fichier par un chemin relatif à l'exécution. La source de vérité
// est donc src/app/, et ce script propage. `npm test` échoue si on oublie.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SHARED = ["praytimes.js", "config.js", "settings.js"];

let changed = 0;
for (const f of SHARED) {
  const from = path.join(ROOT, "src", "app", f);
  const to = path.join(ROOT, "src", "service", f);
  const src = fs.readFileSync(from);
  const dst = fs.existsSync(to) ? fs.readFileSync(to) : null;
  if (dst && src.equals(dst)) {
    console.log("  = " + f + " (déjà identique)");
  } else {
    fs.writeFileSync(to, src);
    console.log("  → " + f + " recopié vers src/service/");
    changed++;
  }
}
console.log(changed ? changed + " fichier(s) mis à jour." : "Rien à faire.");
