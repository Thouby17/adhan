// =====================================================================
// Adhan TV — service de fond
//
// Tourne en Node.js sur la TV. Surveille l'horloge et lance l'app à l'heure
// de chaque prière configurée, même si une autre app est au premier plan.
//
// Principes
//   - Un seul setInterval court (30 s). Aucun timer long, donc aucune dérive.
//   - Les horaires sont manipulés en INSTANTS ABSOLUS (objets Date), jamais en
//     heures décimales : c'est ce qui règle d'un coup l'Isha d'après minuit et
//     les deux changements d'heure annuels.
//   - Le planning couvre hier / aujourd'hui / demain, pour qu'une prière qui
//     tombe après minuit ne soit jamais perdue au basculement de journée.
//   - Les prières déjà jouées sont mémorisées SUR DISQUE : un redémarrage du
//     service ne rejoue pas l'adhan.
//   - Les réglages viennent de ./config.js — le même fichier que l'interface.
// =====================================================================

const fs = require("fs");
const path = require("path");
const Service = require("webos-service");
const PrayTimes = require("./praytimes.js");
const CONFIG = require("./config.js");

const service = new Service(CONFIG.serviceName);

const PT_OPTS = {
  method:    CONFIG.method,
  fajrAngle: CONFIG.fajrAngle,
  ishaAngle: CONFIG.ishaAngle,
  asrFactor: CONFIG.asrMethod === "Hanafi" ? 2 : 1,
  highLats:  CONFIG.highLats
};

function log(msg) { console.log("[adhan-svc] " + msg); }

// --- Clé de journée (date LOCALE) ---------------------------------------
// ⚠️ L'ancienne version utilisait toISOString(), qui renvoie la date UTC : le
// cache basculait à 1 h ou 2 h du matin au lieu de minuit, et travaillait sur
// les horaires de la veille pendant ce créneau.
function dayKey(d) {
  return d.getFullYear() + "-" +
         String(d.getMonth() + 1).padStart(2, "0") + "-" +
         String(d.getDate()).padStart(2, "0");
}

// --- Mémoire des prières déjà jouées ------------------------------------
// Persistée pour survivre à un redémarrage du service (sinon l'adhan repart
// une seconde fois si le service redémarre dans la fenêtre de tolérance).
const STATE_CANDIDATES = [
  process.env.ADHAN_STATE_FILE,
  "/media/developer/temp/adhan-fired.json",
  "/tmp/adhan-fired.json",
  path.join(__dirname, "adhan-fired.json")
].filter(Boolean);

let statePath = null;
let fired = {};        // { "2026-06-21:isha": true, ... }

function loadState() {
  for (const p of STATE_CANDIDATES) {
    try {
      if (fs.existsSync(p)) {
        fired = JSON.parse(fs.readFileSync(p, "utf8")) || {};
        statePath = p;
        log("État rechargé depuis " + p + " (" + Object.keys(fired).length + " entrée(s))");
        return;
      }
    } catch (e) { /* fichier illisible : on passe au suivant */ }
  }
  // Aucun fichier existant : on choisit le premier emplacement inscriptible.
  for (const p of STATE_CANDIDATES) {
    try {
      fs.writeFileSync(p, "{}", "utf8");
      statePath = p;
      log("État initialisé dans " + p);
      return;
    } catch (e) { /* pas inscriptible : suivant */ }
  }
  log("ATTENTION : aucun emplacement inscriptible. Mémoire volatile — un " +
      "redémarrage dans la fenêtre de tolérance peut rejouer un adhan.");
}

function saveState() {
  if (!statePath) return;
  try {
    fs.writeFileSync(statePath, JSON.stringify(fired), "utf8");
  } catch (e) {
    log("Échec d'écriture de l'état : " + e.message);
  }
}

// Ne garde que les clés d'hier, aujourd'hui et demain.
function pruneState(now) {
  const keep = {};
  for (let o = -1; o <= 1; o++) {
    keep[dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + o))] = true;
  }
  let removed = 0;
  for (const k of Object.keys(fired)) {
    if (!keep[k.split(":")[0]]) { delete fired[k]; removed++; }
  }
  return removed;
}

// --- Planning -----------------------------------------------------------
let scheduleKey = "";
let schedule = [];

// Événements d'hier, d'aujourd'hui et de demain, triés dans le temps.
// Couvrir la veille est indispensable : du 15 mai au 31 juillet, l'Isha du
// jour J tombe APRÈS MINUIT, donc au petit matin du jour J+1.
function buildSchedule(now) {
  const events = [];
  for (let o = -1; o <= 1; o++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + o);
    const times = PrayTimes.getTimesAsDates(
      day, CONFIG.latitude, CONFIG.longitude, undefined, PT_OPTS
    );
    for (const p of CONFIG.prayersWithAdhan) {
      if (!times[p]) continue;
      events.push({ id: dayKey(day) + ":" + p, prayer: p, at: times[p] });
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
  const removed = pruneState(now);
  saveState();
  log("Planning reconstruit pour " + key +
      " (" + schedule.length + " événements, " + removed + " ancienne(s) entrée(s) purgée(s))");
  for (const e of schedule) log("   " + e.id + " -> " + e.at.toString());
  return schedule;
}

// --- Boucle de surveillance ---------------------------------------------
function checkPrayers() {
  const now = new Date();
  const events = ensureSchedule(now);
  const windowMs = CONFIG.triggerWindowMinutes * 60 * 1000;

  for (const e of events) {
    const lateMs = now - e.at;
    if (lateMs >= 0 && lateMs < windowMs && !fired[e.id]) {
      fired[e.id] = true;
      saveState();
      log("Heure de prière atteinte : " + e.prayer +
          " (prévue " + e.at.toString() + ", retard " + Math.round(lateMs / 1000) + " s)");
      launchAdhanApp(e.prayer);
    }
  }
}

function launchAdhanApp(prayer) {
  service.call("luna://com.webos.applicationManager/launch", {
    id: CONFIG.appId,
    params: { mode: "alarm", prayer: prayer }
  }, function (msg) {
    if (msg && msg.payload && msg.payload.returnValue) {
      log("App lancée pour " + prayer);
    } else {
      log("ÉCHEC du lancement : " + JSON.stringify(msg && msg.payload));
    }
  });
}

// --- Méthodes exposées ---------------------------------------------------

service.register("start", function (message) {
  ensureSchedule(new Date());
  message.respond({ returnValue: true, status: "running" });
});

// L'interface appelle cette méthode pour afficher EXACTEMENT les horaires que
// le service utilisera pour déclencher — plus de divergence possible entre ce
// qui est affiché et ce qui sonne.
service.register("getTimes", function (message) {
  const now = new Date();
  const times = PrayTimes.getTimes(
    now, CONFIG.latitude, CONFIG.longitude, undefined, PT_OPTS
  );
  const formatted = {};
  for (const k in times) formatted[k] = PrayTimes.formatHM(times[k]);
  message.respond({
    returnValue: true,
    day: dayKey(now),
    times: times,
    formatted: formatted,
    config: CONFIG
  });
});

service.register("triggerNow", function (message) {
  const prayer = (message.payload && message.payload.prayer) || "dhuhr";
  launchAdhanApp(prayer);
  message.respond({ returnValue: true, prayer: prayer });
});

service.register("ping", function (message) {
  message.respond({
    returnValue: true,
    pong: Date.now(),
    scheduleKey: scheduleKey,
    statePath: statePath,
    fired: fired,
    next: schedule.filter(function (e) { return e.at > new Date(); })
                  .slice(0, 3)
                  .map(function (e) { return { prayer: e.prayer, at: e.at.toString() }; })
  });
});

// --- Démarrage -----------------------------------------------------------
log("Démarrage (sondage " + CONFIG.pollSeconds + " s, tolérance " +
    CONFIG.triggerWindowMinutes + " min, prières=" + CONFIG.prayersWithAdhan.join(",") + ")");
log("Angles Fajr/Isha : " + PT_OPTS.fajrAngle + "° / " + PT_OPTS.ishaAngle +
    "°, règle hautes latitudes : " + PT_OPTS.highLats);
loadState();
setInterval(checkPrayers, CONFIG.pollSeconds * 1000);
checkPrayers();
