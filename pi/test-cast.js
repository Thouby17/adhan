// =====================================================================
// Test de la barre de son — sans APK, sans Raspberry Pi
//
// Cherche les appareils Google Cast du réseau local, puis envoie l'adhan
// à celui qu'on lui indique. C'est EXACTEMENT le code qui tournera sur
// l'appareil du salon (pi/player.js) : si ça marche ici, ça marchera là-bas.
//
//   node pi/test-cast.js                 → cherche et liste les appareils
//   node pi/test-cast.js 192.168.1.42    → envoie l'adhan à cette adresse
//   node pi/test-cast.js --scan 20       → cherche pendant 20 secondes
// =====================================================================

const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const CONFIG = require(path.join(ROOT, "src", "app", "config.js"));
const AUDIO = path.join(ROOT, "src", "app", CONFIG.adhanFile);

const args = process.argv.slice(2);
const target = args.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
const scanIdx = args.indexOf("--scan");
const scanSeconds = scanIdx >= 0 ? Number(args[scanIdx + 1]) || 12 : 12;

function line() { console.log("-".repeat(64)); }

// --- Contrôles préalables : mieux vaut échouer ici, en expliquant -------
function preflight() {
  console.log("CONTRÔLES PRÉALABLES");
  line();
  let ok = true;

  if (fs.existsSync(AUDIO)) {
    console.log("  ✓ fichier adhan trouvé (" +
      (fs.statSync(AUDIO).size / 1048576).toFixed(1) + " Mo)");
  } else {
    console.log("  ✗ fichier adhan INTROUVABLE : " + AUDIO);
    ok = false;
  }

  try {
    require.resolve("castv2-client");
    console.log("  ✓ bibliothèque Cast installée");
  } catch (e) {
    console.log("  ✗ bibliothèque Cast absente — lancer : cd pi && npm install");
    ok = false;
  }

  const ifs = os.networkInterfaces();
  const addrs = [];
  for (const k of Object.keys(ifs)) {
    for (const i of ifs[k] || []) {
      if (i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254.")) {
        addrs.push(k + " : " + i.address);
      }
    }
  }
  if (addrs.length) {
    console.log("  ✓ ce PC est sur le réseau :");
    for (const a of addrs) console.log("      " + a);
  } else {
    console.log("  ✗ ce PC n'a aucune adresse réseau utilisable");
    ok = false;
  }
  console.log("");
  return ok;
}

// --- Recherche des appareils Cast (mDNS) --------------------------------
function scan(seconds) {
  return new Promise(function (resolve) {
    let mdns;
    try { mdns = require("multicast-dns")(); }
    catch (e) {
      console.log("Recherche impossible : " + e.message);
      return resolve([]);
    }

    const found = new Map();

    mdns.on("response", function (res) {
      const all = [].concat(res.answers || [], res.additionals || []);
      // Nom lisible de l'appareil, publié dans l'enregistrement TXT
      let name = null;
      for (const r of all) {
        if (r.type === "TXT" && /_googlecast/.test(r.name)) {
          for (const b of [].concat(r.data || [])) {
            const s = b.toString();
            if (s.startsWith("fn=")) name = s.slice(3);
          }
        }
      }
      for (const r of all) {
        if (r.type === "A" && r.data) {
          const isCast = all.some(x => /_googlecast/.test(x.name || ""));
          if (isCast) found.set(r.data, name || found.get(r.data) || "(sans nom)");
        }
      }
    });

    const ask = () => { try { mdns.query({ questions: [
      { name: "_googlecast._tcp.local", type: "PTR" }] }); } catch (e) {} };

    ask();
    const iv = setInterval(ask, 2000);

    setTimeout(function () {
      clearInterval(iv);
      try { mdns.destroy(); } catch (e) {}
      resolve([...found.entries()].map(([ip, name]) => ({ ip, name })));
    }, seconds * 1000);
  });
}

// --- Vérification silencieuse ------------------------------------------
// Déroule TOUTE la chaîne Cast — connexion, lancement du récepteur,
// chargement du média, passage en lecture — puis coupe aussitôt. Environ une
// seconde de son au lieu de trois minutes : de quoi prouver que ça marche
// sans réveiller la maison.
function check(host, holdSec) {
  const HOLD = (holdSec || 8) * 1000;
  return new Promise(function (resolve) {
    let Client, Receiver, http, fsm;
    try {
      Client = require("castv2-client").Client;
      Receiver = require("castv2-client").DefaultMediaReceiver;
      http = require("http"); fsm = require("fs");
    } catch (e) { return resolve({ ok: false, step: "bibliothèque", error: e.message }); }

    // Petit serveur qui expose le MP3, comme le fera l'appareil du salon.
    // ⭐ On JOURNALISE chaque requête : c'est la seule façon de savoir si la
    // barre est réellement venue chercher le fichier. « PLAYING » ne le prouve
    // pas — la barre peut annoncer qu'elle lit et ne rien recevoir.
    let fetched = 0, fetchedBytes = 0, fetchedFrom = null;
    const srv = http.createServer(function (req, res) {
      fetched++;
      fetchedFrom = req.socket.remoteAddress;
      console.log("      ← la barre demande le fichier (" + fetchedFrom + ")");
      const st = fsm.statSync(AUDIO);
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": st.size,
                           "Accept-Ranges": "bytes" });
      const rs = fsm.createReadStream(AUDIO);
      rs.on("data", c => { fetchedBytes += c.length; });
      rs.pipe(res);
    });

    const ifs = os.networkInterfaces();
    let ip = null;
    for (const k of Object.keys(ifs)) for (const i of ifs[k] || []) {
      if (i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254.")) ip = ip || i.address;
    }
    if (!ip) return resolve({ ok: false, step: "réseau", error: "aucune adresse locale" });

    srv.listen(0, function () {
      const url = "http://" + ip + ":" + srv.address().port + "/adhan.mp3";
      const client = new Client();
      const done = r => {
        try { client.close(); } catch (e) {}
        try { srv.close(); } catch (e) {}
        resolve(r);
      };
      const timer = setTimeout(() => done({ ok: false, step: "délai", error: "aucune réponse en 20 s" }), 20000);

      client.on("error", e => { clearTimeout(timer); done({ ok: false, step: "connexion", error: e.message }); });

      console.log("  1/4  connexion à " + host + "…");
      client.connect(host, function () {
        // Cast pilote un volume PROPRE, distinct de celui de la télécommande.
        // S'il est à zéro, la barre « lit » en silence — panne parfaitement
        // silencieuse, et le protocole ne s'en plaint jamais.
        client.getVolume(function (ev, vol) {
          if (!ev && vol) {
            console.log("       volume Cast de la barre : " +
              Math.round((vol.level || 0) * 100) + " %" +
              (vol.muted ? "  ⚠ COUPÉ (mute)" : ""));
            if (vol.muted || (vol.level || 0) < 0.15) {
              console.log("       → on le remonte à 40 % pour le test");
              try { client.setVolume({ level: 0.4, muted: false }, function () {}); } catch (e) {}
            }
          }
        });
        console.log("  2/4  connecté — lancement du récepteur…");
        client.launch(Receiver, function (err, receiver) {
          if (err) { clearTimeout(timer); return done({ ok: false, step: "récepteur", error: err.message }); }
          console.log("  3/4  récepteur lancé — envoi du média…");
          receiver.load({ contentId: url, contentType: "audio/mpeg", streamType: "BUFFERED",
                          metadata: { type: 0, metadataType: 0, title: "Adhan — test" } },
                        { autoplay: true },
            function (err2, status) {
              clearTimeout(timer);
              if (err2) return done({ ok: false, step: "chargement", error: err2.message });

              // ⚠️ L'état renvoyé juste après `load` vaut souvent IDLE : la
              // lecture n'a pas encore commencé. Le prendre pour un succès
              // serait exactement l'échec silencieux qu'on cherche à éviter —
              // on INTERROGE donc la barre jusqu'à la voir vraiment lire.
              const seen = [];
              let tries = 0;
              const poll = setInterval(function () {
                tries++;
                receiver.getStatus(function (e3, st) {
                  const s = (st && st.playerState) || (e3 ? "erreur" : "?");
                  if (seen[seen.length - 1] !== s) seen.push(s);
                  const reason = st && st.idleReason;
                  const playing = s === "PLAYING" || s === "BUFFERING";
                  if ((playing && fetched > 0) || (s === "IDLE" && reason) || tries >= 40) {
                    clearInterval(poll);
                    console.log("  4/4  états observés : " + seen.join(" → ") +
                                (reason ? "  (motif : " + reason + ")" : ""));
                    console.log("       fichier récupéré par la barre : " +
                      (fetched ? "OUI, " + Math.round(fetchedBytes/1024) + " Ko depuis " + fetchedFrom
                               : "NON — elle n'est jamais venue le chercher"));
                    try { receiver.stop(function () {}); } catch (e) {}
                    console.log("       lecture maintenue " + (HOLD/1000) + " s pour laisser la barre se reveiller…");
                    setTimeout(() => done((playing && fetched > 0)
                      ? { ok: true, states: seen, kb: Math.round(fetchedBytes/1024) }
                      : { ok: false, step: "lecture", states: seen,
                          error: (fetched ? "la barre n'a jamais atteint l'état PLAYING" : "la barre n'est JAMAIS venue chercher le fichier — le pare-feu Windows bloque probablement Node.js en entrée") +
                                 (reason ? " (motif : " + reason + ")" : "") }), HOLD + 600);
                  }
                });
              }, 300);
            });
        });
      });
    });
  });
}

// --- Envoi -------------------------------------------------------------
async function send(host) {
  const player = require("./player.js");
  console.log("ENVOI DE L'ADHAN VERS " + host);
  line();
  console.log("  Éteins la barre (veille) si tu veux vérifier le réveil.");
  console.log("  Envoi en cours…\n");

  const t0 = Date.now();
  const results = await player.play(AUDIO, { audioOutput: "cast", castHost: host });
  const ms = Date.now() - t0;

  for (const r of results) {
    if (r.ok) console.log("  ✓ RÉUSSI via " + r.how + "  (" + ms + " ms)");
    else console.log("  ✗ ÉCHEC via " + r.how + " : " + r.error);
  }
  console.log("");
  if (results.some(r => r.ok)) {
    console.log("  L'adhan devrait sortir de la barre. Il dure 3 minutes.");
    console.log("  Ctrl+C pour arrêter ce programme (le son continue jusqu'au bout).");
  } else {
    line();
    console.log("  PISTES, dans l'ordre :");
    console.log("   1. La barre est-elle sur le MÊME réseau Wi-Fi que ce PC ?");
    console.log("   2. Son adresse IP a-t-elle changé ? Relancer sans argument pour rechercher.");
    console.log("   3. Le pare-feu Windows bloque-t-il Node.js ? C'est lui qui sert le fichier.");
  }
  setTimeout(() => { player.shutdown(); process.exit(0); }, 200000);
}

// --- Programme ----------------------------------------------------------
(async function () {
  console.log("");
  console.log("TEST DE LA BARRE DE SON — " + (CONFIG.placeName || ""));
  line();
  console.log("");

  if (!preflight()) { process.exit(1); }

  if (target && args.includes("--check")) {
    console.log("VÉRIFICATION SILENCIEUSE VERS " + target);
    line();
    console.log("  Environ 1 seconde de son, puis coupure.\n");
    const hold = Number(args[args.indexOf("--check") + 1]) || 8;
    const r = await check(target, hold);
    console.log("");
    line();
    if (r.ok) {
      console.log("  ✅ CHAÎNE COMPLÈTE VALIDÉE — la barre a atteint l'état PLAYING.");
      console.log("     États traversés : " + (r.states || []).join(" → "));
      console.log("");
      console.log("     ⚠️ Ceci prouve que la barre a ACCEPTÉ et LANCÉ la lecture.");
      console.log("     Que le son soit réellement sorti se vérifie avec l'oreille,");
      console.log("     et avec le volume de la barre.");
    } else {
      console.log("  ❌ ÉCHEC à l'étape « " + r.step + " » : " + r.error);
      if (r.states) console.log("     États traversés : " + r.states.join(" → "));
    }
    process.exit(r.ok ? 0 : 1);
  }

  if (target) return send(target);

  console.log("RECHERCHE DES APPAREILS CAST (" + scanSeconds + " s)");
  line();
  console.log("  La barre doit être ALLUMÉE et sur le Wi-Fi pour se signaler.\n");

  const devices = await scan(scanSeconds);
  if (!devices.length) {
    console.log("  Aucun appareil trouvé.");
    console.log("");
    console.log("  Ce n'est pas forcément un échec : la recherche par mDNS est");
    console.log("  souvent bloquée par le pare-feu ou par un réseau qui isole");
    console.log("  les appareils entre eux.");
    console.log("");
    console.log("  ⇒ Récupère l'adresse IP de la barre dans l'application");
    console.log("     SmartThings ou sur ta box, puis relance :");
    console.log("     node pi/test-cast.js 192.168.x.x");
    process.exit(0);
  }

  console.log("  Appareils trouvés :");
  for (const d of devices) console.log("    " + d.ip.padEnd(16) + d.name);
  console.log("");
  console.log("  ⇒ Relance avec l'adresse de la barre :");
  console.log("     node pi/test-cast.js " + devices[0].ip);
  process.exit(0);
})();
