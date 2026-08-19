// Petit serveur statique pour tester l'interface dans un navigateur, sans TV.
//   npm run serve   puis http://localhost:8080
const http = require("http"), fs = require("fs"), path = require("path");
const PROJ = path.join(__dirname, "..");
const ROOT = path.join(PROJ, "src", "app");
const TYPES = { ".html":"text/html", ".js":"application/javascript",
                ".css":"text/css", ".mp3":"audio/mpeg", ".m4a":"audio/mp4", ".png":"image/png" };
http.createServer(function (req, res) {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  let file = path.join(ROOT, rel === "/" ? "index.html" : rel);
  // Permet aussi de servir le build autonome, qui est a la racine du projet.
  if (!fs.existsSync(file)) file = path.join(PROJ, rel);
  if (!file.startsWith(PROJ)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); return res.end("404"); }
    // Interdiction de mettre en cache : sans ça, le navigateur garde
    // index.html et style.css et on croit que rien n'a changé après une
    // modification. C'est un serveur de mise au point, la fraîcheur prime
    // sur la vitesse.
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });
    res.end(data);
  });
}).listen(8080, function () {
  const os = require("os"), n = os.networkInterfaces();
  console.log("Sur ce PC     : http://localhost:8080");
  for (const k of Object.keys(n)) {
    for (const i of n[k] || []) {
      if (i.family === "IPv4" && !i.internal) {
        console.log("Sur le reseau : http://" + i.address + ":8080");
      }
    }
  }
  console.log("");
  console.log("/!\\ Depuis un AUTRE appareil (tablette, telephone), le pare-feu");
  console.log("    Windows bloque ce port par defaut : la page tourne dans le");
  console.log("    vide, sans message d'erreur. Voir README.md, section");
  console.log("    \"Tester sur une tablette\".");
});
