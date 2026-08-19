// =====================================================================
// Sortie audio de l'appareil du salon.
//
// Trois façons de jouer l'adhan, choisies par config.js (`audioOutput`) :
//
//   "cast"   — envoie vers la barre de son Samsung par le Wi-Fi (Google Cast).
//              ⭐ C'est la bonne option : Cast PREND LA MAIN sur la barre quelle
//              que soit son entrée du moment. Une liaison HDMI, elle, ne
//              s'entendrait pas tant que la barre est restée sur l'entrée TV.
//
//   "local"  — joue sur la sortie audio du Raspberry Pi (petit haut-parleur).
//              Le filet de sécurité : lui est toujours allumé.
//
//   "both"   — les deux. Recommandé tant qu'on n'a pas vérifié si la barre
//              sort de veille toute seule à la réception d'un flux.
//
//   "dryrun" — ne joue rien, journalise seulement. Utilisé par les tests.
// =====================================================================

const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");

function log(msg) { console.log("[player] " + msg); }

// --- Adresse IP locale, pour que la barre sache où venir chercher le son ---
function localAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return null;
}

// --- Petit serveur qui expose le MP3 sur le réseau local -------------------
// Google Cast ne reçoit pas un fichier : on lui donne une URL à aller lire.
let fileServer = null;
let fileServerPort = 0;

function ensureFileServer(audioPath) {
  if (fileServer) return Promise.resolve(fileServerPort);
  return new Promise(function (resolve, reject) {
    fileServer = http.createServer(function (req, res) {
      fs.stat(audioPath, function (err, st) {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": st.size });
        fs.createReadStream(audioPath).pipe(res);
      });
    });
    fileServer.on("error", reject);
    fileServer.listen(0, function () {
      fileServerPort = fileServer.address().port;
      log("Fichier audio exposé sur le port " + fileServerPort);
      resolve(fileServerPort);
    });
  });
}

// --- Lecture locale --------------------------------------------------------
// mpg123 est le lecteur le plus léger et le plus fiable sur Raspberry Pi OS.
//   sudo apt install mpg123
function playLocal(audioPath, opts) {
  return new Promise(function (resolve) {
    const args = [];
    if (opts && opts.alsaDevice) args.push("-a", opts.alsaDevice);
    args.push("-q", audioPath);
    let child;
    try {
      child = spawn("mpg123", args, { stdio: "ignore" });
    } catch (e) {
      log("mpg123 introuvable : " + e.message + " (sudo apt install mpg123)");
      return resolve({ ok: false, how: "local", error: e.message });
    }
    child.on("error", function (e) {
      log("Échec de la lecture locale : " + e.message);
      resolve({ ok: false, how: "local", error: e.message });
    });
    child.on("exit", function (code) {
      resolve({ ok: code === 0, how: "local", code: code });
    });
  });
}

// --- Envoi vers la barre de son (Google Cast) ------------------------------
// Nécessite `npm install` dans pi/ (dépendance castv2-client).
function playCast(audioPath, opts) {
  let Client, DefaultMediaReceiver;
  try {
    Client = require("castv2-client").Client;
    DefaultMediaReceiver = require("castv2-client").DefaultMediaReceiver;
  } catch (e) {
    log("castv2-client absent — lancer `npm install` dans pi/. " + e.message);
    return Promise.resolve({ ok: false, how: "cast", error: "module absent" });
  }

  const host = opts && opts.castHost;
  if (!host) {
    return Promise.resolve({ ok: false, how: "cast", error: "castHost non renseigné dans config.js" });
  }

  return ensureFileServer(audioPath).then(function (port) {
    const ip = localAddress();
    if (!ip) return { ok: false, how: "cast", error: "adresse IP locale introuvable" };
    const url = "http://" + ip + ":" + port + "/adhan.mp3";

    return new Promise(function (resolve) {
      const client = new Client();
      const done = function (r) {
        try { client.close(); } catch (e) {}
        resolve(r);
      };
      const timer = setTimeout(function () {
        done({ ok: false, how: "cast", error: "délai dépassé (barre éteinte ou injoignable ?)" });
      }, 20000);

      client.on("error", function (err) {
        clearTimeout(timer);
        done({ ok: false, how: "cast", error: err.message });
      });

      client.connect(host, function () {
        // ⚠️ GARDE-FOU APPRIS À LA DURE (18/08/2026). Cast pilote un volume
        // PROPRE, distinct de celui de la télécommande. Trouvé à 11 % : la
        // barre annonçait « PLAYING », téléchargeait le fichier — et personne
        // n'entendait l'adhan. Une panne qui ne se signale nulle part.
        const floor = (opts.castMinVolume === undefined) ? 0.4 : opts.castMinVolume;
        if (floor !== null) {
          try {
            client.getVolume(function (ev, vol) {
              if (ev || !vol) return;
              if (vol.muted || (vol.level || 0) < floor) {
                log("Volume Cast à " + Math.round((vol.level || 0) * 100) +
                    "% — remonté à " + Math.round(floor * 100) + "%");
                try { client.setVolume({ level: floor, muted: false }, function () {}); } catch (e) {}
              }
            });
          } catch (e) { /* jamais bloquant : le son prime sur le réglage */ }
        }
        client.launch(DefaultMediaReceiver, function (err, receiver) {
          if (err) { clearTimeout(timer); return done({ ok: false, how: "cast", error: err.message }); }
          receiver.load(
            { contentId: url, contentType: "audio/mpeg", streamType: "BUFFERED",
              metadata: { type: 0, metadataType: 0, title: "Adhan" } },
            { autoplay: true },
            function (err2) {
              clearTimeout(timer);
              if (err2) return done({ ok: false, how: "cast", error: err2.message });
              log("Envoyé à la barre de son (" + host + ")");
              done({ ok: true, how: "cast" });
            }
          );
        });
      });
    });
  });
}

// --- Point d'entrée --------------------------------------------------------
// Ne rejette jamais : un échec de sortie audio ne doit pas tuer le service.
// Retourne le détail de CHAQUE tentative, pour que l'appelant puisse le
// journaliser et que l'échec soit visible plutôt que silencieux.
function play(audioPath, opts) {
  opts = opts || {};
  const mode = opts.audioOutput || "both";

  if (mode === "dryrun") {
    log("DRYRUN — l'adhan aurait été joué (" + path.basename(audioPath) + ")");
    return Promise.resolve([{ ok: true, how: "dryrun" }]);
  }

  const jobs = [];
  if (mode === "local" || mode === "both") jobs.push(playLocal(audioPath, opts));
  if (mode === "cast" || mode === "both") jobs.push(playCast(audioPath, opts));
  if (!jobs.length) return Promise.resolve([{ ok: false, how: mode, error: "mode inconnu" }]);

  return Promise.all(jobs.map(function (p) {
    return p.catch(function (e) { return { ok: false, how: "?", error: e.message }; });
  }));
}

function shutdown() {
  if (fileServer) { try { fileServer.close(); } catch (e) {} fileServer = null; }
}

module.exports = { play: play, shutdown: shutdown, localAddress: localAddress };
