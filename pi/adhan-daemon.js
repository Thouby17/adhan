// =====================================================================
// Adhan — service de fond de l'appareil du salon (Raspberry Pi)
//
// Même cerveau que le service webOS : planning en instants absolus couvrant
// hier / aujourd'hui / demain, mémoire des adhans joués écrite sur disque,
// fuseau recalculé pour la date visée. Seule la SORTIE change : au lieu de
// demander à webOS de lancer une app, on joue le son (haut-parleur et/ou
// barre Samsung en Wi-Fi).
//
// Ce que le Pi apporte et que la TV ne pourra jamais avoir :
//   - il est allumé en permanence : plus aucune prière ratée parce que
//     l'écran était éteint ;
//   - systemd le relance automatiquement s'il meurt ou au redémarrage.
//
//   node pi/adhan-daemon.js
//   node pi/adhan-daemon.js --dry-run        (n'émet aucun son)
//   node pi/adhan-daemon.js --test-son       (joue l'adhan tout de suite)
// =====================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const PrayTimes = require(path.join(ROOT, "src", "app", "praytimes.js"));
const DEFAULTS = require(path.join(ROOT, "src", "app", "config.js"));
const S = require(path.join(ROOT, "src", "app", "settings.js"));
const player = require("./player.js");

const ARGS = process.argv.slice(2);
const DRY = ARGS.indexOf("--dry-run") >= 0;

const AUDIO = path.join(ROOT, "src", "app", DEFAULTS.adhanFile);

// Configuration effective = valeurs livrées + préférences de l'utilisateur.
// ⭐ C'est CE service qui détient les préférences, et l'écran vient les lire
// chez lui. Le principe est celui qui a déjà évité un bug coûteux : une seule
// source de vérité, donc impossible d'afficher une heure et d'en sonner une
// autre.
const SETTINGS_FILE = process.env.ADHAN_SETTINGS_FILE ||
  path.join(process.env.HOME || os.tmpdir(), ".adhan-settings.json");

let overrides = {};
let CONFIG = DEFAULTS;
let PT_OPTS = S.ptOptions(CONFIG);
let PLAY_OPTS = {};

function applyOverrides(o) {
  overrides = o || {};
  CONFIG = S.effective(DEFAULTS, overrides);
  PT_OPTS = S.ptOptions(CONFIG);
  PLAY_OPTS = {
    audioOutput: DRY ? "dryrun" : (CONFIG.audioOutput || "both"),
    castHost:    CONFIG.castHost,
    castMinVolume: CONFIG.castMinVolume,
    alsaDevice:  CONFIG.alsaDevice
  };
  scheduleKey = "";          // le planning sera reconstruit au prochain tour
}

function loadOverrides() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      applyOverrides(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) || {});
      log("Préférences chargées : " + JSON.stringify(overrides));
      return;
    }
  } catch (e) {
    log("Préférences illisibles (" + e.message + ") — valeurs d'origine appliquées.");
  }
  applyOverrides({});
}

function saveOverrides(o) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(o, null, 1), "utf8");
  applyOverrides(o);
}

function ts() {
  const d = new Date();
  return d.toISOString().slice(0, 19).replace("T", " ");
}
const QUIET = process.env.ADHAN_QUIET === "1";   // utilisé par les tests
function log(msg) { if (!QUIET) console.log(ts() + " [adhan] " + msg); }

function dayKey(d) {
  return d.getFullYear() + "-" +
         String(d.getMonth() + 1).padStart(2, "0") + "-" +
         String(d.getDate()).padStart(2, "0");
}
function stamp(d) {
  return dayKey(d) + " " + String(d.getHours()).padStart(2, "0") +
         ":" + String(d.getMinutes()).padStart(2, "0");
}

// --- Mémoire des prières déjà jouées ------------------------------------
const STATE_FILE = process.env.ADHAN_STATE_FILE ||
  path.join(process.env.HOME || os.tmpdir(), ".adhan-fired.json");
let fired = {};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fired = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {};
      log("État rechargé (" + Object.keys(fired).length + " entrée(s)) : " + STATE_FILE);
      return;
    }
  } catch (e) { log("État illisible, on repart de zéro : " + e.message); }
  fired = {};
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(fired), "utf8"); }
  catch (e) { log("Échec d'écriture de l'état : " + e.message); }
}
function pruneState(now) {
  const keep = {};
  for (let o = -1; o <= 1; o++) {
    keep[dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + o))] = true;
  }
  for (const k of Object.keys(fired)) if (!keep[k.split(":")[0]]) delete fired[k];
}

// --- Planning ------------------------------------------------------------
let scheduleKey = "";
let schedule = [];

function timesFor(day) {
  return PrayTimes.getTimesAsDates(day, CONFIG.latitude, CONFIG.longitude, undefined, PT_OPTS);
}

// Hier / aujourd'hui / demain : indispensable, l'Isha du jour J tombe après
// minuit du 15 mai au 31 juillet, donc au petit matin de J+1.
function buildSchedule(now) {
  const events = [];
  for (let o = -1; o <= 1; o++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + o);
    const t = timesFor(day);
    for (const p of CONFIG.prayersWithAdhan) {
      if (t[p]) events.push({ id: dayKey(day) + ":" + p, prayer: p, at: t[p] });
    }
  }
  events.sort(function (a, b) { return a.at - b.at; });
  return events;
}

function ensureSchedule(now) {
  const key = dayKey(now);
  if (key === scheduleKey && schedule.length) return schedule;
  schedule = buildSchedule(now);
  scheduleKey = key;
  pruneState(now);
  saveState();
  const today = timesFor(now);
  log("Horaires du " + key + " — " +
      ["fajr", "dhuhr", "asr", "maghrib", "isha"]
        .map(function (p) { return p + " " + stamp(today[p]).slice(11); }).join("  "));
  return schedule;
}

// --- Boucle --------------------------------------------------------------
function tick() {
  const now = new Date();
  const events = ensureSchedule(now);
  const windowMs = CONFIG.triggerWindowMinutes * 60 * 1000;

  for (const e of events) {
    const lateMs = now - e.at;
    if (lateMs >= 0 && lateMs < windowMs && !fired[e.id]) {
      fired[e.id] = true;
      saveState();
      log("▶ " + e.prayer.toUpperCase() + " — prévu " + stamp(e.at) +
          ", retard " + Math.round(lateMs / 1000) + " s");
      fire(e.prayer);
    }
  }
}

function fire(prayer) {
  player.play(AUDIO, PLAY_OPTS).then(function (results) {
    // Un échec de sortie audio ne doit JAMAIS passer inaperçu : c'est
    // exactement le genre de panne silencieuse qui fait qu'on découvre le
    // problème trois semaines plus tard.
    for (const r of results) {
      if (r.ok) log("   son OK via " + r.how);
      else log("   ⚠ ÉCHEC via " + r.how + " : " + r.error);
    }
    if (!results.some(function (r) { return r.ok; })) {
      log("   ⚠⚠ AUCUNE sortie audio n'a fonctionné pour " + prayer);
    }
  });
}

// --- Petit serveur d'état, pour l'écran et pour le diagnostic -------------
function startStatusServer() {
  const port = Number(process.env.ADHAN_STATUS_PORT || CONFIG.statusPort || 8081);
  if (!port) { log("Serveur d'état désactivé."); return; }
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  const send = (res, code, obj) => {
    res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS));
    res.end(JSON.stringify(obj, null, 1));
  };

  const server = http.createServer(function (req, res) {
    const route = req.url.split("?")[0];

    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

    // --- Préférences : l'écran les lit et les écrit ici ------------------
    if (route === "/settings") {
      if (req.method === "GET") {
        return send(res, 200, { overrides: overrides, effective: CONFIG, defaults: DEFAULTS });
      }
      if (req.method === "POST") {
        let body = "";
        req.on("data", c => {
          body += c;
          if (body.length > 64 * 1024) { req.destroy(); }   // garde-fou
        });
        req.on("end", function () {
          let patch;
          try { patch = JSON.parse(body || "{}"); }
          catch (e) { return send(res, 400, { error: "JSON illisible : " + e.message }); }
          const v = S.validate(patch);
          if (!v.ok) return send(res, 400, { error: "Réglages refusés", details: v.errors });
          try {
            saveOverrides(S.diff(DEFAULTS, S.effective(DEFAULTS, patch)));
          } catch (e) {
            return send(res, 500, { error: "Écriture impossible : " + e.message });
          }
          log("Préférences mises à jour depuis l'écran : " + JSON.stringify(overrides));
          ensureSchedule(new Date());
          return send(res, 200, { ok: true, overrides: overrides, effective: CONFIG });
        });
        return;
      }
      return send(res, 405, { error: "Méthode non autorisée" });
    }

    // --- État courant ----------------------------------------------------
    const now = new Date();
    const today = timesFor(now);
    const out = { now: now.toISOString(), day: dayKey(now), formatted: {}, next: null,
                  place: CONFIG.placeName || null,
                  audioOutput: PLAY_OPTS.audioOutput, castHost: CONFIG.castHost || null };
    for (const p of ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"]) {
      if (today[p]) out.formatted[p] = stamp(today[p]).slice(11);
    }
    const next = schedule.filter(function (e) { return e.at > now; })[0];
    if (next) out.next = { prayer: next.prayer, at: next.at.toISOString() };
    send(res, 200, out);
  });

  // Le serveur d'état n'est qu'un confort d'affichage. S'il ne peut pas
  // démarrer (port occupé, par exemple après un redémarrage rapide), il ne
  // doit SURTOUT PAS emporter le service avec lui : l'adhan passe avant.
  server.on("error", function (e) {
    log("⚠ Serveur d'état indisponible (" + e.message + ") — l'adhan continue normalement.");
  });
  server.listen(port, function () {
    log("État consultable sur http://localhost:" + port);
  });
}

// --- Démarrage -----------------------------------------------------------
loadOverrides();
log("Démarrage — " + PT_OPTS.fajrAngle + "°/" + PT_OPTS.ishaAngle + "°, " +
    "hautes latitudes " + PT_OPTS.highLats + ", Asr " + CONFIG.asrMethod);
log("Sortie audio : " + PLAY_OPTS.audioOutput +
    (CONFIG.castHost ? " (barre : " + CONFIG.castHost + ")" : ""));

if (!fs.existsSync(AUDIO)) log("⚠ Fichier audio introuvable : " + AUDIO);

if (ARGS.indexOf("--test-son") >= 0) {
  log("Test de son immédiat…");
  fire("test");
  setTimeout(function () { player.shutdown(); process.exit(0); }, 30000);
} else {
  loadState();
  startStatusServer();
  setInterval(tick, CONFIG.pollSeconds * 1000);
  tick();
}

process.on("SIGTERM", function () { player.shutdown(); process.exit(0); });
process.on("SIGINT", function () { player.shutdown(); process.exit(0); });
