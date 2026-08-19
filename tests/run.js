// =====================================================================
// Adhan TV — tests
//
// Rejoue les cinq scénarios de l'audit du 17/08/2026 :
//   changement d'heure · nuits d'été · Isha après minuit · redémarrage · gel.
//
// Les tests chargent le VRAI src/service/adhan_service.js avec une horloge
// simulée et un faux module webOS — c'est le fichier livré qui est éprouvé,
// pas une copie de sa logique.
//
//   node tests/run.js
// =====================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const RealDate = Date;

// ---------------------------------------------------------------------
// Micro-harnais
// ---------------------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
const pending = [];   // tests qui rendent une promesse

function record(name, err) {
  if (err) {
    failed++;
    failures.push({ name: name, message: err.message });
    console.log("  ✗ " + name);
    console.log("      " + err.message);
  } else {
    passed++;
    console.log("  ✓ " + name);
  }
}

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(r.then(function () { record(name, null); },
                          function (e) { record(name, e); }));
    } else {
      record(name, null);
    }
  } catch (e) {
    record(name, e);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function section(t) { console.log("\n" + t); console.log("-".repeat(t.length)); }

// ---------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------
const PrayTimes = require(path.join(ROOT, "src", "app", "praytimes.js"));
const CONFIG = require(path.join(ROOT, "src", "app", "config.js"));

const LAT = CONFIG.latitude, LNG = CONFIG.longitude;
const OPTS = {
  method: CONFIG.method,
  fajrAngle: CONFIG.fajrAngle,
  ishaAngle: CONFIG.ishaAngle,
  asrFactor: CONFIG.asrMethod === "Hanafi" ? 2 : 1,
  highLats: CONFIG.highLats
};
const PRAYERS = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

// Bibliothèque de référence PrayTimes.org v2.5, chargée en bac à sable.
const sandbox = { Math, Date: RealDate, String, Number, parseInt, parseFloat, isNaN, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "vendor", "PrayTimes-ref.js"), "utf8"), sandbox);
const ref = sandbox.prayTimes;

function tzAt(y, m, d) { return -new RealDate(y, m - 1, d, 12).getTimezoneOffset() / 60; }
function hmToMin(s) {
  if (!s || s.indexOf(":") < 0) return NaN;
  const p = s.split(":");
  return Number(p[0]) * 60 + Number(p[1]);
}
// Écart circulaire en minutes entre deux heures de la journée.
function circDiff(a, b) {
  let d = a - b;
  while (d > 720) d -= 1440;
  while (d < -720) d += 1440;
  return d;
}
function eachDay(year, fn) {
  const d = new RealDate(year, 0, 1);
  while (d.getFullYear() === year) {
    fn(d.getFullYear(), d.getMonth() + 1, d.getDate());
    d.setDate(d.getDate() + 1);
  }
}

// ---------------------------------------------------------------------
// Chargement du vrai service avec une horloge simulée
// ---------------------------------------------------------------------
let NOW = 0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}

const SERVICE = path.join(ROOT, "src", "service", "adhan_service.js");
const STATE_FILE = path.join(os.tmpdir(), "adhan-test-fired.json");

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === "webos-service") return path.join(__dirname, "stubs", "webos-service.js");
  return origResolve.call(this, req, ...rest);
};

let tickFn = null;
const realSetInterval = global.setInterval;

function bootService(startMs, opts) {
  opts = opts || {};
  if (!opts.keepState) { try { fs.unlinkSync(STATE_FILE); } catch (e) {} }
  process.env.ADHAN_STATE_FILE = STATE_FILE;
  NOW = startMs;
  global.Date = FakeDate;
  global.setInterval = function (fn) { tickFn = fn; return 0; };
  global.__ADHAN_LAUNCHES = [];
  for (const m of [SERVICE,
                   path.join(ROOT, "src", "service", "praytimes.js"),
                   path.join(ROOT, "src", "service", "config.js")]) {
    delete require.cache[require.resolve(m)];
  }
  const realLog = console.log;
  console.log = function () {};          // le service est bavard au démarrage
  try { require(SERVICE); } finally { console.log = realLog; }
}

function runClock(fromMs, toMs, stepSec) {
  const step = (stepSec || 60) * 1000;
  for (let t = fromMs; t <= toMs; t += step) {
    NOW = t;
    const realLog = console.log;
    console.log = function () {};
    try { tickFn(); } finally { console.log = realLog; }
  }
}

function stopService() {
  global.Date = RealDate;
  global.setInterval = realSetInterval;
}

function launches() {
  return (global.__ADHAN_LAUNCHES || []).map(function (l) {
    return { prayer: l.prayer, at: new RealDate(l.at.getTime()) };
  });
}
const T = (...a) => new RealDate(...a).getTime();
const stamp = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
  "-" + String(d.getDate()).padStart(2, "0") + " " +
  String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");

// =====================================================================
// ⚠️ CES TESTS PORTENT SUR L'HEURE BELGE. Ils rejouent les deux dimanches de
// changement d'heure et les nuits d'été de Bruxelles — donc ils DOIVENT
// tourner en Europe/Brussels. Sur une machine en UTC (celle de GitHub, par
// exemple), huit d'entre eux échouent pour une raison qui n'a rien à voir
// avec le code. Mieux vaut un message clair qu'une liste d'échecs trompeuse.
const TZ_ATTENDU = "Europe/Brussels";
const TZ_REEL = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (TZ_REEL !== TZ_ATTENDU) {
  console.error("");
  console.error("FUSEAU HORAIRE INCORRECT");
  console.error("-".repeat(56));
  console.error("  attendu : " + TZ_ATTENDU);
  console.error("  obtenu  : " + TZ_REEL);
  console.error("");
  console.error("  Ces tests vérifient les changements d'heure et les nuits");
  console.error("  d'été de Bruxelles : ils n'ont de sens que dans ce fuseau.");
  console.error("");
  console.error("  Relancer avec :   TZ=Europe/Brussels npm test");
  console.error("  (sous PowerShell : $env:TZ='Europe/Brussels'; npm test)");
  console.error("");
  process.exit(1);
}

console.log("Adhan TV — tests");
console.log("Fuseau de la machine : " + TZ_REEL);
console.log("Réglages testés : " + OPTS.fajrAngle + "°/" + OPTS.ishaAngle +
            "°, hautes latitudes = " + OPTS.highLats + ", Asr = " + CONFIG.asrMethod);

// ---------------------------------------------------------------------
section("1. Les copies partagées sont identiques");
// ---------------------------------------------------------------------
for (const f of ["praytimes.js", "config.js", "settings.js"]) {
  test(f + " : src/app et src/service sont identiques", function () {
    const a = fs.readFileSync(path.join(ROOT, "src", "app", f));
    const b = fs.readFileSync(path.join(ROOT, "src", "service", f));
    assert(a.equals(b),
      f + " diverge entre l'interface et le service. Lancer `npm run sync`. " +
      "C'est exactement le scénario où l'écran affiche une heure et l'adhan en sonne une autre.");
  });
}

// ---------------------------------------------------------------------
section("2. Conformité à la référence PrayTimes.org v2.5");
// ---------------------------------------------------------------------
test("lever / Dhuhr / Asr / Maghrib : écart < 2 min sur toute l'année", function () {
  ref.setMethod("MWL");
  ref.adjust({ fajr: OPTS.fajrAngle, isha: OPTS.ishaAngle, asr: "Standard", highLats: "None" });
  let worst = { d: 0 };
  eachDay(2026, function (y, m, dd) {
    const tz = tzAt(y, m, dd);
    const r = ref.getTimes(new RealDate(y, m - 1, dd), [LAT, LNG], tz, 0, "24h");
    const p = PrayTimes.getTimes(new RealDate(y, m - 1, dd), LAT, LNG, tz,
      Object.assign({}, OPTS, { highLats: "None" }));
    for (const k of ["sunrise", "dhuhr", "asr", "maghrib"]) {
      const diff = circDiff(PrayTimes.fixHour(p[k]) * 60, hmToMin(r[k]));
      if (Math.abs(diff) > Math.abs(worst.d)) worst = { d: diff, k: k, date: dd + "/" + m };
    }
  });
  assert(Math.abs(worst.d) < 2,
    "écart maximum " + worst.d.toFixed(2) + " min (" + worst.k + " le " + worst.date + ")");
});

test("Fajr / Isha : écart < 2 min avec la MÊME règle hautes latitudes (le bug corrigé)", function () {
  ref.setMethod("MWL");
  ref.adjust({ fajr: OPTS.fajrAngle, isha: OPTS.ishaAngle, asr: "Standard", highLats: OPTS.highLats });
  let worst = { d: 0 };
  eachDay(2026, function (y, m, dd) {
    const tz = tzAt(y, m, dd);
    const r = ref.getTimes(new RealDate(y, m - 1, dd), [LAT, LNG], tz, 0, "24h");
    const p = PrayTimes.getTimes(new RealDate(y, m - 1, dd), LAT, LNG, tz, OPTS);
    for (const k of ["fajr", "isha"]) {
      const diff = circDiff(PrayTimes.fixHour(p[k]) * 60, hmToMin(r[k]));
      if (Math.abs(diff) > Math.abs(worst.d)) worst = { d: diff, k: k, date: dd + "/" + m };
    }
  });
  assert(Math.abs(worst.d) < 2,
    "écart maximum " + worst.d.toFixed(2) + " min (" + worst.k + " le " + worst.date +
    "). Avant correction : jusqu'à 88 min, sur 100 jours de l'année.");
});

// ---------------------------------------------------------------------
section("3. Nuits d'été : aucune discontinuité");
// ---------------------------------------------------------------------
// Mesuré à fuseau FIXE (+1 toute l'année) : on isole ainsi la progression
// solaire de la convention d'horloge. Les deux dimanches de changement d'heure
// déplacent légitimement l'heure murale d'une heure — ce n'est pas une
// discontinuité astronomique, et la mesurer en heure murale ferait échouer le
// test pour une bonne raison.
function noJump(label, key) {
  test(label, function () {
    let prev = null, worst = { d: 0 };
    eachDay(2026, function (y, m, dd) {
      const t = PrayTimes.getTimes(new RealDate(y, m - 1, dd), LAT, LNG, 1, OPTS);
      const cur = PrayTimes.fixHour(t[key]) * 60;
      if (prev !== null) {
        const d = Math.abs(circDiff(cur, prev));
        if (d > Math.abs(worst.d)) worst = { d: d, date: dd + "/" + m };
      }
      prev = cur;
    });
    assert(worst.d <= 10,
      "saut de " + worst.d.toFixed(0) + " min le " + worst.date +
      " (avant correction : 74 min sur le Fajr entre le 25 et le 26 mai)");
  });
}
noJump("Fajr ne saute jamais de plus de 10 min d'un jour au lendemain", "fajr");
noJump("Isha non plus", "isha");

test("Dhuhr reste plausible toute l'année (garde-fou équation du temps)", function () {
  const bad = [];
  eachDay(2026, function (y, m, dd) {
    const t = PrayTimes.getTimes(new RealDate(y, m - 1, dd), LAT, LNG, 1, OPTS);
    if (t.dhuhr < 11 || t.dhuhr > 14) bad.push(dd + "/" + m + " = " + t.dhuhr.toFixed(2) + " h");
  });
  assert(bad.length === 0,
    bad.length + " jour(s) aberrant(s), ex. " + bad.slice(0, 3).join(", ") +
    ". Autour de l'équinoxe de mars, l'ascension droite du soleil franchit 0 h : " +
    "sans normalisation, l'équation du temps saute de 24 h et Dhuhr tombe à -11 h.");
});

test("aucun horaire indéfini, aucun jour de l'année", function () {
  const bad = [];
  eachDay(2026, function (y, m, dd) {
    const t = PrayTimes.getTimesAsDates(new RealDate(y, m - 1, dd), LAT, LNG, undefined, OPTS);
    for (const k of PRAYERS) if (!t[k] || isNaN(+t[k])) bad.push(k + " le " + dd + "/" + m);
  });
  assert(bad.length === 0, bad.length + " valeur(s) indéfinie(s) : " + bad.slice(0, 5).join(", "));
});

// ---------------------------------------------------------------------
section("4. Isha après minuit");
// ---------------------------------------------------------------------
test("les 5 prières d'une journée sont toujours dans l'ordre chronologique", function () {
  const bad = [];
  eachDay(2026, function (y, m, dd) {
    const t = PrayTimes.getTimesAsDates(new RealDate(y, m - 1, dd), LAT, LNG, undefined, OPTS);
    for (let i = 1; i < PRAYERS.length; i++) {
      if (!(t[PRAYERS[i]] > t[PRAYERS[i - 1]])) {
        bad.push(PRAYERS[i] + " <= " + PRAYERS[i - 1] + " le " + dd + "/" + m);
      }
    }
  });
  assert(bad.length === 0,
    bad.length + " jour(s) dans le désordre, ex. " + bad.slice(0, 3).join(" | ") +
    ". Avant correction : 77 jours où Isha passait avant Maghrib, donc invisible à l'écran.");
});

test("l'Isha du 21 juin tombe bien le 22 juin au petit matin", function () {
  const t = PrayTimes.getTimesAsDates(new RealDate(2026, 5, 21), LAT, LNG, undefined, OPTS);
  assert(t.isha.getDate() === 22 && t.isha.getMonth() === 5,
    "Isha rendu le " + stamp(t.isha) + " au lieu du 22 juin");
  assert(t.isha.getHours() === 0,
    "heure inattendue : " + stamp(t.isha));
});

// ---------------------------------------------------------------------
section("5. Service : une année entière, minute par minute");
// ---------------------------------------------------------------------
test("chaque prière de l'année sonne exactement une fois, à l'heure", function () {
  const START = T(2026, 0, 1, 0, 0, 0);
  const END = T(2026, 11, 31, 23, 59, 0);

  // Attendu DÉRIVÉ de la bibliothèque, pas retapé : la liste des instants que
  // le service aurait dû honorer.
  const expected = [];
  eachDay(2026, function (y, m, dd) {
    const t = PrayTimes.getTimesAsDates(new RealDate(y, m - 1, dd), LAT, LNG, undefined, OPTS);
    for (const p of CONFIG.prayersWithAdhan) {
      if (t[p]) expected.push({ prayer: p, at: t[p], hits: 0 });
    }
  });
  // On ignore les bords : l'Isha du 31/12/2025 et celui du 31/12/2026 tombent
  // hors de la fenêtre simulée.
  const DAY = 24 * 3600 * 1000;
  const inWindow = e => +e.at > START + DAY && +e.at < END - DAY;

  bootService(START);
  // Pas de 60 s alors que le service sonde toutes les 30 s : condition plus
  // dure que la réalité. Si ça passe ici, ça passe sur la TV.
  runClock(START, END, 60);
  const L = launches();
  stopService();

  const orphans = [];
  for (const l of L) {
    const match = expected.find(function (e) {
      return e.prayer === l.prayer &&
             l.at - e.at >= 0 &&
             l.at - e.at < (CONFIG.triggerWindowMinutes + 1) * 60 * 1000;
    });
    if (!match) { orphans.push(l.prayer + " à " + stamp(l.at)); continue; }
    match.hits++;
  }
  assert(orphans.length === 0,
    orphans.length + " déclenchement(s) sans horaire correspondant : " + orphans.slice(0, 3).join(", "));

  const missed = expected.filter(e => inWindow(e) && e.hits === 0);
  const doubled = expected.filter(e => e.hits > 1);
  assert(missed.length === 0,
    missed.length + " prière(s) manquée(s), ex. " +
    missed.slice(0, 3).map(e => e.prayer + " " + stamp(e.at)).join(" | "));
  assert(doubled.length === 0,
    doubled.length + " prière(s) jouée(s) plusieurs fois, ex. " +
    doubled.slice(0, 3).map(e => e.prayer + " " + stamp(e.at) + " ×" + e.hits).join(" | "));

  const nb = CONFIG.prayersWithAdhan.length;
  assert(L.length >= 365 * nb - nb,
    L.length + " déclenchements seulement, ~" + 365 * nb + " attendus");
});

// ---------------------------------------------------------------------
section("6. Changement d'heure");
// ---------------------------------------------------------------------
function dstCase(label, y, m, d, tzExpected) {
  test(label, function () {
    // Attendu DÉRIVÉ de la bibliothèque de référence, avec le fuseau réellement
    // en vigueur ce jour-là — pas recalculé par le code testé.
    ref.setMethod("MWL");
    ref.adjust({ fajr: OPTS.fajrAngle, isha: OPTS.ishaAngle, asr: "Standard", highLats: OPTS.highLats });
    const r = ref.getTimes(new RealDate(y, m - 1, d), [LAT, LNG], tzExpected, 0, "24h");

    bootService(T(y, m - 1, d - 1, 20, 0, 0));
    runClock(T(y, m - 1, d - 1, 20, 0, 0), T(y, m - 1, d, 23, 59, 0), 30);
    const L = launches().filter(l => l.at.getDate() === d);
    stopService();

    for (const prayer of ["dhuhr", "asr", "maghrib"]) {
      const got = L.find(l => l.prayer === prayer);
      assert(got, prayer + " n'a pas sonné");
      const expected = hmToMin(r[prayer]);
      const actual = got.at.getHours() * 60 + got.at.getMinutes();
      const late = circDiff(actual, expected);
      assert(late >= 0 && late <= CONFIG.triggerWindowMinutes + 1,
        prayer + " lancé à " + stamp(got.at) + " alors que l'heure correcte est " +
        r[prayer] + " (écart " + late + " min). Avant correction : 60 min d'erreur.");
    }
  });
}
dstCase("dimanche 29 mars 2026 (02 h -> 03 h) : à l'heure, pas 1 h trop tôt", 2026, 3, 29, 2);
dstCase("dimanche 25 octobre 2026 (03 h -> 02 h) : à l'heure, pas 1 h trop tard", 2026, 10, 25, 1);

// ---------------------------------------------------------------------
section("7. Redémarrage, gel, rattrapage");
// ---------------------------------------------------------------------
test("un redémarrage du service ne rejoue pas un adhan déjà passé", function () {
  bootService(T(2026, 5, 21, 13, 40, 0));
  runClock(T(2026, 5, 21, 13, 40, 0), T(2026, 5, 21, 13, 50, 0), 30);
  const avant = launches().length;
  assert(avant === 1, avant + " déclenchement(s) avant relance, 1 attendu");

  // relance dans la fenêtre de tolérance, en gardant l'état sur disque
  bootService(T(2026, 5, 21, 13, 46, 0), { keepState: true });
  runClock(T(2026, 5, 21, 13, 46, 0), T(2026, 5, 21, 13, 50, 0), 30);
  const apres = launches().length;
  stopService();
  assert(apres === 0,
    apres + " déclenchement(s) après relance, 0 attendu. Avant correction : l'adhan repartait.");
});

test("une prière déjà passée depuis longtemps n'est pas rattrapée au démarrage", function () {
  bootService(T(2026, 5, 21, 19, 0, 0));   // Dhuhr et Asr sont derrière nous
  runClock(T(2026, 5, 21, 19, 0, 0), T(2026, 5, 21, 21, 0, 0), 30);
  const L = launches();
  stopService();
  assert(L.length === 0, "rattrapage inattendu : " + L.map(l => l.prayer).join(","));
});

test("l'Isha d'été se déclenche bien après minuit, le lendemain civil", function () {
  bootService(T(2026, 5, 21, 21, 0, 0));
  runClock(T(2026, 5, 21, 21, 0, 0), T(2026, 5, 22, 2, 0, 0), 30);
  const L = launches();
  stopService();
  const isha = L.find(l => l.prayer === "isha");
  assert(isha, "Isha n'a pas sonné (prières vues : " + L.map(l => l.prayer).join(",") + ")");
  assert(isha.at.getDate() === 22 && isha.at.getHours() === 0,
    "Isha lancé à " + stamp(isha.at) + ", attendu le 22 juin peu après minuit");
});

test("un gel du service au-delà de la tolérance perd la prière (comportement assumé)", function () {
  bootService(T(2026, 5, 21, 13, 0, 0));
  runClock(T(2026, 5, 21, 13, 0, 0), T(2026, 5, 21, 13, 43, 0), 30);
  NOW = T(2026, 5, 21, 13, 50, 0);          // 7 min de gel à cheval sur Dhuhr
  const realLog = console.log; console.log = function () {};
  try { tickFn(); } finally { console.log = realLog; }
  runClock(T(2026, 5, 21, 13, 51, 0), T(2026, 5, 21, 15, 0, 0), 30);
  const L = launches();
  stopService();
  assert(L.length === 0,
    "un rattrapage a eu lieu — si c'est voulu, ce test doit être mis à jour");
});

// ---------------------------------------------------------------------
section("8. Appareil du salon (Raspberry Pi)");
// ---------------------------------------------------------------------
// Il existe maintenant DEUX programmes qui décident quand sonner : le service
// webOS et le daemon du Pi. C'est exactement la situation qui a produit le
// bug « l'écran affiche une heure, l'adhan en sonne une autre ». On vérifie
// donc qu'ils déclenchent aux mêmes instants, sur les périodes qui piègent.
const PI_DAEMON = path.join(ROOT, "pi", "adhan-daemon.js");
const PI_STATE = path.join(os.tmpdir(), "adhan-test-pi.json");
let piTicks = null;

function bootPi(startMs) {
  try { fs.unlinkSync(PI_STATE); } catch (e) {}
  process.env.ADHAN_STATE_FILE = PI_STATE;
  process.env.ADHAN_STATUS_PORT = '0';
  process.env.ADHAN_QUIET = '1';   // pas de serveur d'état pendant les tests
  NOW = startMs;
  global.Date = FakeDate;
  global.setInterval = function (fn) { piTicks = fn; return 0; };
  global.__PI_FIRED = [];
  delete require.cache[require.resolve(PI_DAEMON)];
  delete require.cache[require.resolve(path.join(ROOT, "pi", "player.js"))];
  // On remplace la sortie audio par un mouchard : on teste l'ORDONNANCEMENT,
  // pas la carte son.
  const playerPath = require.resolve(path.join(ROOT, "pi", "player.js"));
  require.cache[playerPath] = {
    id: playerPath, filename: playerPath, loaded: true, exports: {
      play: function () {
        global.__PI_FIRED.push(new RealDate(NOW));
        return Promise.resolve([{ ok: true, how: "test" }]);
      },
      shutdown: function () {}, localAddress: function () { return "127.0.0.1"; }
    }
  };
  const realLog = console.log;
  console.log = function () {};
  try { require(PI_DAEMON); } finally { console.log = realLog; }
}

function runPi(fromMs, toMs, stepSec) {
  const step = (stepSec || 60) * 1000;
  for (let t = fromMs; t <= toMs; t += step) {
    NOW = t;
    const realLog = console.log; console.log = function () {};
    try { piTicks(); } finally { console.log = realLog; }
  }
}

test("le daemon Pi sonne aux MÊMES instants que le service TV (juin + bascules horaires)", function () {
  const periodes = [
    ["nuits d'été", T(2026, 5, 15, 0, 0, 0), T(2026, 5, 25, 23, 59, 0)],
    ["bascule de mars", T(2026, 2, 27, 0, 0, 0), T(2026, 2, 31, 23, 59, 0)],
    ["bascule d'octobre", T(2026, 9, 23, 0, 0, 0), T(2026, 9, 27, 23, 59, 0)]
  ];
  for (const [label, a, b] of periodes) {
    bootService(a);
    runClock(a, b, 60);
    const tv = launches().map(l => +l.at);
    stopService();

    bootPi(a);
    runPi(a, b, 60);
    const pi = (global.__PI_FIRED || []).map(d => +d);
    global.Date = RealDate;
    global.setInterval = realSetInterval;

    assert(tv.length > 0, label + " : le service TV n'a rien déclenché (test invalide)");
    assert(pi.length === tv.length,
      label + " : " + pi.length + " déclenchements côté Pi contre " + tv.length + " côté TV");
    for (let i = 0; i < tv.length; i++) {
      assert(pi[i] === tv[i],
        label + " : écart au déclenchement n°" + (i + 1) + " — Pi " +
        stamp(new RealDate(pi[i])) + " contre TV " + stamp(new RealDate(tv[i])));
    }
  }
});

test("le daemon Pi ne rejoue pas un adhan après un redémarrage", function () {
  bootPi(T(2026, 5, 21, 13, 40, 0));
  runPi(T(2026, 5, 21, 13, 40, 0), T(2026, 5, 21, 13, 50, 0), 30);
  const avant = (global.__PI_FIRED || []).length;
  assert(avant === 1, avant + " déclenchement(s), 1 attendu");

  process.env.ADHAN_STATE_FILE = PI_STATE;   // on garde l'état sur disque
  NOW = T(2026, 5, 21, 13, 46, 0);
  global.__PI_FIRED = [];
  delete require.cache[require.resolve(PI_DAEMON)];
  const realLog = console.log; console.log = function () {};
  try { require(PI_DAEMON); } finally { console.log = realLog; }
  runPi(T(2026, 5, 21, 13, 46, 0), T(2026, 5, 21, 13, 50, 0), 30);
  const apres = (global.__PI_FIRED || []).length;
  global.Date = RealDate;
  global.setInterval = realSetInterval;
  assert(apres === 0, apres + " déclenchement(s) après relance, 0 attendu");
});

test("une panne de sortie audio est signalée, jamais silencieuse", function () {
  delete require.cache[require.resolve(path.join(ROOT, "pi", "player.js"))];
  const player = require(path.join(ROOT, "pi", "player.js"));
  return player.play("/chemin/inexistant.mp3", { audioOutput: "cast", castHost: null })
    .then(function (results) {
      assert(results.length === 1 && results[0].ok === false,
        "un échec doit être remonté explicitement");
      assert(typeof results[0].error === "string" && results[0].error.length > 0,
        "l'échec doit porter une raison lisible, pas juste `false`");
    });
});

// ---------------------------------------------------------------------
section("9. Réglages modifiables");
// ---------------------------------------------------------------------
const Settings = require(path.join(ROOT, "src", "app", "settings.js"));
const SET_FILE = path.join(os.tmpdir(), "adhan-test-settings.json");

test("une saisie invalide est refusée, avec un message qui dit quoi faire", function () {
  const cases = [
    [{ latitude: 120 }, "latitude"],
    [{ longitude: "abc" }, "longitude"],
    [{ fajrAngle: 40 }, "fajrAngle"],
    [{ highLats: "Nimportequoi" }, "highLats"],
    [{ asrMethod: "Maliki" }, "asrMethod"],
    [{ prayersWithAdhan: ["fajr", "brunch"] }, "prayersWithAdhan"],
    [{ castHost: "192.168.1.1; rm -rf /" }, "castHost"]
  ];
  for (const [patch, champ] of cases) {
    const v = Settings.validate(patch);
    assert(!v.ok && v.errors[champ], "accepté à tort : " + JSON.stringify(patch));
    assert(v.errors[champ].length > 25,
      "message trop sec pour « " + champ + " » : « " + v.errors[champ] + " »");
    assert(!(champ in v.values), champ + " ne doit pas être retenu quand il est invalide");
  }
});

test("une préférence invalide ne casse pas la configuration : on garde l'usine", function () {
  const cfg = Settings.effective(CONFIG, { latitude: 999, fajrAngle: 15 });
  assert(cfg.latitude === CONFIG.latitude,
    "latitude aberrante appliquée : " + cfg.latitude);
  assert(cfg.fajrAngle === 15, "l'angle valide du même lot aurait dû passer");
});

test("seules les différences sont enregistrées", function () {
  const cfg = Settings.effective(CONFIG, { fajrAngle: 12 });
  const d = Settings.diff(CONFIG, cfg);
  assert(Object.keys(d).length === 1 && d.fajrAngle === 12,
    "attendu {fajrAngle:12}, obtenu " + JSON.stringify(d));
});

test("les prières sont remises dans l'ordre chronologique, quel que soit l'ordre de saisie", function () {
  const v = Settings.validate({ prayersWithAdhan: ["isha", "fajr", "asr"] });
  assert(v.values.prayersWithAdhan.join(",") === "fajr,asr,isha",
    "obtenu " + v.values.prayersWithAdhan.join(","));
});

test("⭐ activer le son du Fajr le fait RÉELLEMENT sonner", function () {
  const jour = [2026, 5, 21];                       // 21 juin
  const t = PrayTimes.getTimesAsDates(new RealDate(jour[0], jour[1], jour[2]),
    LAT, LNG, undefined, OPTS);

  // 1. réglages d'origine : Fajr est muet
  fs.writeFileSync(SET_FILE, "{}", "utf8");
  process.env.ADHAN_SETTINGS_FILE = SET_FILE;
  bootPi(T(jour[0], jour[1], jour[2], 2, 0, 0));
  runPi(T(jour[0], jour[1], jour[2], 2, 0, 0), T(jour[0], jour[1], jour[2], 6, 0, 0), 60);
  const avant = (global.__PI_FIRED || []).length;
  global.Date = RealDate; global.setInterval = realSetInterval;
  assert(avant === 0, "Fajr a sonné alors qu'il est désactivé par défaut");

  // 2. on active Fajr, comme le ferait l'écran de réglages
  fs.writeFileSync(SET_FILE, JSON.stringify({
    prayersWithAdhan: ["fajr", "dhuhr", "asr", "maghrib", "isha"]
  }), "utf8");
  bootPi(T(jour[0], jour[1], jour[2], 2, 0, 0));
  runPi(T(jour[0], jour[1], jour[2], 2, 0, 0), T(jour[0], jour[1], jour[2], 6, 0, 0), 60);
  const apres = (global.__PI_FIRED || []).map(d => +d);
  global.Date = RealDate; global.setInterval = realSetInterval;

  assert(apres.length === 1, apres.length + " déclenchement(s), 1 attendu (le Fajr)");
  const retard = (apres[0] - +t.fajr) / 60000;
  assert(retard >= 0 && retard <= CONFIG.triggerWindowMinutes + 1,
    "Fajr lancé à " + stamp(new RealDate(apres[0])) + " au lieu de " + stamp(t.fajr));
});

test("changer de lieu change réellement les horaires déclenchés", function () {
  // Marseille : 6 degrés plus au sud et 1,2 degré plus à l'est.
  fs.writeFileSync(SET_FILE, JSON.stringify({
    latitude: 43.2965, longitude: 5.3698, placeName: "Marseille"
  }), "utf8");
  process.env.ADHAN_SETTINGS_FILE = SET_FILE;
  bootPi(T(2026, 5, 21, 12, 0, 0));
  runPi(T(2026, 5, 21, 12, 0, 0), T(2026, 5, 21, 23, 0, 0), 60);
  const marseille = (global.__PI_FIRED || []).map(d => +d);
  global.Date = RealDate; global.setInterval = realSetInterval;

  const attendu = PrayTimes.getTimesAsDates(new RealDate(2026, 5, 21),
    43.2965, 5.3698, undefined, OPTS);
  const bxl = PrayTimes.getTimesAsDates(new RealDate(2026, 5, 21), LAT, LNG, undefined, OPTS);

  // On compare le MAGHRIB, pas le Dhuhr : le midi solaire ne dépend presque que
  // de la longitude (5 min d'écart ici), alors que le coucher dépend fortement
  // de la latitude (38 min). Comparer le Dhuhr laisserait passer un réglage de
  // latitude totalement ignoré.
  assert(Math.abs(+attendu.maghrib - +bxl.maghrib) > 20 * 60000,
    "test creux : les deux villes donnent le même Maghrib");

  const maghrib = marseille.find(function (t) {
    return Math.abs(t - +attendu.maghrib) < (CONFIG.triggerWindowMinutes + 1) * 60000;
  });
  assert(maghrib,
    "aucun déclenchement à l'heure du Maghrib de Marseille (" + stamp(attendu.maghrib) +
    "). Déclenchements observés : " +
    marseille.map(t => stamp(new RealDate(t))).join(", "));
  try { fs.unlinkSync(SET_FILE); } catch (e) {}
  delete process.env.ADHAN_SETTINGS_FILE;
});

// ---------------------------------------------------------------------
Promise.all(pending).then(function () {
  try { fs.unlinkSync(STATE_FILE); } catch (e) {}
  try { fs.unlinkSync(PI_STATE); } catch (e) {}
  Module._resolveFilename = origResolve;

  console.log("\n" + "=".repeat(56));
  console.log(passed + " réussi(s), " + failed + " échec(s)");
  if (failed) {
    console.log("\nÉchecs :");
    for (const f of failures) console.log("  - " + f.name + "\n    " + f.message);
  }
  console.log("=".repeat(56));
  process.exit(failed ? 1 : 0);
});
