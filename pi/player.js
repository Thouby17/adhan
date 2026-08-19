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

// Le type MIME est DÉDUIT du fichier, jamais recopié : il l'était à onze
// endroits, et le passage du MP3 à l'AAC obligeait à les retrouver tous.
const SETTINGS = require(path.join(__dirname, "..", "src", "app", "settings.js"));
const CONFIG_APP = require(path.join(__dirname, "..", "src", "app", "config.js"));
const MIME = SETTINGS.mimeAudio(CONFIG_APP.adhanFile);

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
        res.writeHead(200, { "Content-Type": MIME, "Content-Length": st.size });
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
// ⚠️ mpg123 ne lit QUE du MP3, et l'adhan est passé en AAC pour tenir dans
// moitié moins de place. On essaie donc plusieurs lecteurs, du plus complet au
// plus léger, et on garde le premier qui démarre vraiment.
//   sudo apt install mpv        (ou ffmpeg, ou mpg123 si on revient au MP3)
const LECTEURS = [
  { cmd: "mpv",    args: ["--no-video", "--really-quiet"], alsa: d => ["--audio-device=alsa/" + d] },
  { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet"], alsa: null },
  { cmd: "mpg123", args: ["-q"], alsa: d => ["-a", d] }
];

function playLocal(audioPath, opts) {
  return new Promise(function (resolve) {

    // ⚠️ spawn() NE LÈVE RIEN si le programme est absent : il émet un
    // événement « error » plus tard. Un try/catch autour de spawn ne détecte
    // donc jamais un lecteur manquant — d'où cet essai en cascade, piloté par
    // l'événement et non par une exception.
    function essayer(i) {
      if (i >= LECTEURS.length) {
        const noms = LECTEURS.map(l => l.cmd).join(", ");
        log("Aucun lecteur audio disponible. Installer l'un de : " + noms);
        return resolve({ ok: false, how: "local", error: "aucun lecteur (" + noms + ")" });
      }

      const l = LECTEURS[i];
      const args = l.args.slice();
      if (opts && opts.alsaDevice && l.alsa) args.push.apply(args, l.alsa(opts.alsaDevice));
      args.push(audioPath);

      let child;
      try {
        child = spawn(l.cmd, args, { stdio: "ignore" });
      } catch (e) {
        return essayer(i + 1);
      }

      let fini = false;
      child.on("error", function () {
        // Programme introuvable, ou refusé : au suivant, sans bruit.
        if (fini) return;
        fini = true;
        essayer(i + 1);
      });
      child.on("exit", function (code) {
        if (fini) return;
        fini = true;
        // Un code non nul au PREMIER lecteur peut signifier « format non
        // reconnu » (le cas exact de mpg123 face à un AAC) : on laisse sa
        // chance au suivant plutôt que de conclure à un échec.
        if (code !== 0 && i + 1 < LECTEURS.length) return essayer(i + 1);
        if (code === 0) log("Lecture locale terminée (" + l.cmd + ")");
        resolve({ ok: code === 0, how: "local", code: code, lecteur: l.cmd });
      });
    }

    essayer(0);
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
    const url = "http://" + ip + ":" + port + "/" + path.basename(AUDIO);

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
            { contentId: url, contentType: MIME, streamType: "BUFFERED",
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
