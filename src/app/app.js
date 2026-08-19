// =====================================================================
// Adhan — application
//
// Quatre onglets : Aujourd'hui · Qibla · Mois · Réglages.
//
// Les horaires sont manipulés en INSTANTS ABSOLUS (objets Date), exactement
// comme dans le service de fond : c'est ce qui rend correct un Isha tombant
// après minuit (du 15 mai au 31 juillet à Bruxelles) et les deux jours de
// changement d'heure.
//
// L'écran et le service partagent config.js, settings.js et praytimes.js à
// l'identique (vérifié par `npm test`) : ils ne peuvent pas afficher une
// heure et en sonner une autre.
// =====================================================================

(function () {
  "use strict";

  const LABELS = { fajr: "Fajr", dhuhr: "Dhuhr", asr: "Asr",
                   maghrib: "Maghrib", isha: "Isha", test: "Test" };
  const PRAYERS = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

  const DEFAULTS = window.ADHAN_CONFIG;
  const S = window.AdhanSettings;
  const PrayTimes = window.PrayTimes;

  let cfg = DEFAULTS;
  let PT_OPTS = S.ptOptions(cfg);

  const dom = {};
  const state = {
    dayKey: "", today: null, schedule: [], fired: {},
    view: "today", monthCursor: null, reminded: {},
    lastCount: "", lastNextId: "",
    fastTimer: null, slowTimer: null,
    heading: null            // cap de la boussole, si disponible
  };

  // ---------- Préférences : le service fait autorité s'il répond ---------
  const STORE_KEY = "adhan.settings.v1";
  let store = "local";
  let overrides = {};

  const daemonUrl = p => location.protocol + "//" + (location.hostname || "localhost") +
                         ":" + (DEFAULTS.statusPort || 8081) + p;

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; }
  }
  function writeLocal(o) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); return true; }
    catch (e) { log("Préférences non enregistrables : " + e.message); return false; }
  }
  function applyOverrides(o) {
    overrides = o || {};
    cfg = S.effective(DEFAULTS, overrides);
    PT_OPTS = S.ptOptions(cfg);
    state.dayKey = ""; state.lastNextId = ""; state.lastCount = "";
  }
  function loadSettings(done) {
    let settled = false;
    const finish = (o, where) => { if (settled) return; settled = true; store = where; applyOverrides(o); done(); };
    if (typeof fetch !== "function") return finish(readLocal(), "local");
    const timer = setTimeout(() => finish(readLocal(), "local"), 1200);
    fetch(daemonUrl("/settings"))
      .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
      .then(j => { clearTimeout(timer); finish(j.overrides || {}, "service"); })
      .catch(() => { clearTimeout(timer); finish(readLocal(), "local"); });
  }
  function persistSettings(o, done) {
    if (store !== "service") return done(writeLocal(o), null);
    fetch(daemonUrl("/settings"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(o)
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
      .then(() => done(true, null))
      .catch(e => done(false, e.message));
  }

  // ---------- Outils ----------------------------------------------------
  function log(msg) {
    if (typeof console !== "undefined") console.log(msg);
    if (!dom.logArea) return;
    const p = document.createElement("p");
    p.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
    dom.logArea.appendChild(p);
    while (dom.logArea.childNodes.length > 100) dom.logArea.removeChild(dom.logArea.firstChild);
    dom.logArea.scrollTop = dom.logArea.scrollHeight;
  }

  const dayKey = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
                      "-" + String(d.getDate()).padStart(2, "0");
  const hm = d => d ? String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") : "--:--";
  const timesFor = day => PrayTimes.getTimesAsDates(day, cfg.latitude, cfg.longitude, undefined, PT_OPTS);

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }
  function svg(tag, attrs) {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // ---------- Planning --------------------------------------------------
  function buildSchedule(now) {
    const events = [];
    for (let o = -1; o <= 1; o++) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + o);
      const t = timesFor(day);
      for (const p of PRAYERS) {
        if (t[p]) events.push({ id: dayKey(day) + ":" + p, prayer: p, at: t[p] });
      }
    }
    events.sort((a, b) => a.at - b.at);
    return events;
  }

  function refreshDailyCache() {
    const now = new Date();
    const key = dayKey(now);
    if (key === state.dayKey && state.today) return;
    state.today = timesFor(now);
    state.schedule = buildSchedule(now);
    state.dayKey = key;
    renderHeader();
    renderRows();
    drawSky();
    if (state.view === "track") renderTrack();
    if (state.view === "month") renderMonth();
    if (state.view === "qibla") renderQibla();
    updateNightMode();
    log("Horaires recalculés pour " + key);
  }

  const findNext = () => state.schedule.find(e => e.at > new Date()) || null;
  const findPrev = () => { let last = null; for (const e of state.schedule) { if (e.at <= new Date()) last = e; else break; } return last; };

  // ---------- Aujourd'hui : en-tête -------------------------------------
  function renderHeader() {
    dom.placeName.textContent = cfg.placeName || "Position réglée";
    dom.qiblaPlace.textContent = cfg.placeName || "Position réglée";
    const now = new Date();
    dom.dateGreg.textContent = now.toLocaleDateString("fr-BE",
      { weekday: "long", day: "numeric", month: "long" });
    // Date hégirienne : fournie par le navigateur, hors ligne. Absente sur
    // certains vieux moteurs — on n'affiche rien plutôt qu'une valeur fausse.
    try {
      dom.dateHijri.textContent = new Intl.DateTimeFormat("fr-FR-u-ca-islamic-umalqura",
        { day: "numeric", month: "long", year: "numeric" }).format(now);
    } catch (e) { dom.dateHijri.textContent = ""; }
  }

  // ---------- Suivi des prières -----------------------------------------
  // Données PERSONNELLES, gardées sur l'appareil et jamais envoyées au
  // service : le service décide quand sonner, pas ce qui a été accompli.
  // Forme : { "2026-08-18": { fajr: 1, dhuhr: 1, ... } }
  const TRACK_KEY = "adhan.tracking.v1";
  const SINCE_KEY = "adhan.tracking.since.v1";
  const TRACK_DAYS = 30;
  let tracking = {};
  let trackSince = null;      // premier jour où le suivi existe

  function loadTracking() {
    try { tracking = JSON.parse(localStorage.getItem(TRACK_KEY)) || {}; } catch (e) { tracking = {}; }
    // ⚠️ Les jours ANTÉRIEURS à la première utilisation ne sont pas des
    // prières manquées : l'app n'existait pas. Sans cette date, un nouvel
    // utilisateur ouvre l'onglet et découvre 145 cases rouges et « 0 % » —
    // le plus décourageant des accueils, et c'est faux.
    try {
      trackSince = localStorage.getItem(SINCE_KEY);
      if (!trackSince) {
        trackSince = dayKey(new Date());
        localStorage.setItem(SINCE_KEY, trackSince);
      }
    } catch (e) { trackSince = dayKey(new Date()); }
    pruneTracking();
  }

  const counts = k => !trackSince || k >= trackSince;   // ce jour est-il suivi ?
  function saveTracking() {
    try { localStorage.setItem(TRACK_KEY, JSON.stringify(tracking)); }
    catch (e) { log("Suivi non enregistrable : " + e.message); }
  }
  // On ne garde qu'un trimestre : assez pour les statistiques, sans laisser
  // le stockage grossir indéfiniment.
  function pruneTracking() {
    const limit = new Date();
    limit.setDate(limit.getDate() - 92);
    for (const k of Object.keys(tracking)) if (k < dayKey(limit)) delete tracking[k];
  }

  const isDone = (k, p) => !!(tracking[k] && tracking[k][p]);

  function toggleDone(k, p) {
    if (!tracking[k]) tracking[k] = {};
    if (tracking[k][p]) delete tracking[k][p]; else tracking[k][p] = 1;
    if (!Object.keys(tracking[k]).length) delete tracking[k];
    saveTracking();
    renderTrack();
    hideReminder();
  }

  function renderTrack() {
    if (!dom.trackToday || !state.today) return;
    const now = new Date();
    const k = dayKey(now);

    // --- les 5 prières du jour
    dom.trackToday.innerHTML = "";
    for (const p of PRAYERS) {
      const at = state.today[p];
      const done = isDone(k, p);
      const past = at && at <= now;
      const b = el("button", "track-item");
      b.type = "button";
      if (done) b.classList.add("is-done");
      else if (past) b.classList.add("is-missed");
      else b.classList.add("is-future");
      b.setAttribute("aria-pressed", done ? "true" : "false");
      b.appendChild(el("span", "tick"));
      b.appendChild(el("span", null, LABELS[p]));
      b.appendChild(el("span", "when", hm(at)));
      b.addEventListener("click", () => toggleDone(k, p));
      dom.trackToday.appendChild(b);
    }

    // --- grille des 30 derniers jours
    dom.trackGrid.innerHTML = "";
    const days = [];
    for (let i = TRACK_DAYS - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      days.push({ d: d, k: dayKey(d) });
    }
    for (const p of PRAYERS) {
      dom.trackGrid.appendChild(el("div", "lbl", LABELS[p].slice(0, 4)));
      for (const day of days) {
        const cell = el("i");
        const at = timesFor(day.d)[p];
        if (isDone(day.k, p)) cell.className = "done";
        else if (at && at <= now && counts(day.k)) cell.className = "miss";
        else cell.className = "todo";
        cell.title = LABELS[p] + " — " + day.d.toLocaleDateString("fr-BE");
        dom.trackGrid.appendChild(cell);
      }
    }

    // --- statistiques
    let doneMonth = 0, dueMonth = 0, total = 0;
    for (const key of Object.keys(tracking)) total += Object.keys(tracking[key]).length;
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    for (let d = new Date(first); d <= now; d.setDate(d.getDate() + 1)) {
      const kk = dayKey(d), tm = timesFor(d);
      if (!counts(kk)) continue;
      for (const p of PRAYERS) {
        if (tm[p] && tm[p] <= now) { dueMonth++; if (isDone(kk, p)) doneMonth++; }
      }
    }
    dom.statRate.textContent = dueMonth ? Math.round(doneMonth / dueMonth * 100) + " %" : "—";
    dom.statTotal.textContent = String(total);

    // Série : jours consécutifs où TOUTES les prières échues sont marquées.
    // On part d'hier si le jour en cours n'est pas fini — sinon la série
    // tomberait à zéro chaque matin, ce qui serait décourageant et faux.
    let streak = 0;
    for (let i = 0; i < 92; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const kk = dayKey(d), tm = timesFor(d);
      if (!counts(kk)) break;
      let due = 0, ok = 0;
      for (const p of PRAYERS) if (tm[p] && tm[p] <= now) { due++; if (isDone(kk, p)) ok++; }
      if (due === 0) continue;
      if (ok === due) streak++;
      else if (i === 0) continue;      // journée en cours : on ne la juge pas
      else break;
    }
    dom.statStreak.textContent = String(streak);
    if (dom.dhikrToday) dom.dhikrToday.textContent = dhikr.total + " aujourd'hui";
  }

  // ---------- Aujourd'hui : lignes de prière ----------------------------
  function renderRows() {
    if (!state.today) return;
    dom.rows.innerHTML = "";
    const now = new Date();
    const next = findNext();

    const prev = findPrev();

    // Fin du temps de chaque prière. ⚠️ Le Fajr ne finit PAS à Dhuhr mais au
    // LEVER DU SOLEIL — une version antérieure affichait « Fajr jusqu'à 13:47 »,
    // ce qui est faux de sept heures.
    function endOf(p) {
      if (p === "fajr") return state.today.sunrise || null;
      return next ? next.at : null;
    }

    // On construit la liste dans l'ordre, le lever intercalé à sa place —
    // pas d'insertion différée, qui dupliquait la ligne à chaque redessin.
    const entries = [];
    for (const p of PRAYERS) {
      entries.push({ kind: "prayer", key: p, at: state.today[p] });
      if (p === "fajr" && state.today.sunrise) {
        entries.push({ kind: "marker", label: "Lever du soleil — fin du Fajr",
                       at: state.today.sunrise });
      }
    }

    for (const e of entries) {
      const li = el("li", "row");
      if (e.at && e.at <= now) li.classList.add("is-passed");

      if (e.kind === "marker") {
        li.classList.add("is-marker");
        li.appendChild(el("span", "row-name", e.label));
        li.appendChild(el("span", "row-time", hm(e.at)));
        dom.rows.appendChild(li);
        continue;
      }

      const p = e.key;
      const isNext = next && next.prayer === p && e.at && +next.at === +e.at;
      if (isNext) li.classList.add("is-next");

      const nameBox = el("span", "row-name");
      nameBox.appendChild(document.createTextNode(LABELS[p]));
      // Prière en cours : jusqu'à quand son temps court. C'est la deuxième
      // question qu'on se pose après « c'est quand, la prochaine ? ».
      const end = endOf(p);
      if (prev && prev.prayer === p && !isNext && end && end > now) {
        nameBox.appendChild(el("span", "row-until", "jusqu'à " + hm(end)));
        li.classList.remove("is-passed");
      }
      li.appendChild(nameBox);
      li.appendChild(el("span", "row-time", hm(e.at)));

      // La cloche agit là où on regarde l'horaire — pas dans un autre écran.
      const on = cfg.prayersWithAdhan.indexOf(p) !== -1;
      const b = el("button", "bell");
      b.type = "button";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.setAttribute("aria-label", (on ? "Couper" : "Activer") + " l'adhan pour " + LABELS[p]);
      b.appendChild(el("span", "bell-ico"));
      b.addEventListener("click", () => toggleBell(p));
      li.appendChild(b);

      dom.rows.appendChild(li);
    }
  }

  function toggleBell(prayer) {
    const list = cfg.prayersWithAdhan.slice();
    const i = list.indexOf(prayer);
    if (i === -1) list.push(prayer); else list.splice(i, 1);
    const v = S.validate({ prayersWithAdhan: list });
    if (!v.ok) return;
    const next = S.diff(DEFAULTS, S.effective(DEFAULTS, Object.assign({}, overrides, v.values)));
    persistSettings(next, function (ok, err) {
      if (!ok) { log("Réglage non enregistré : " + (err || "stockage indisponible")); return; }
      applyOverrides(next);
      refreshDailyCache();
      renderRows();
      if (dom.setPrayers) fillSettingsForm();
      log((i === -1 ? "Adhan activé pour " : "Adhan coupé pour ") + LABELS[prayer]);
    });
  }

  // ---------- Aujourd'hui : héros + avancement --------------------------
  function tickFast() {
    const now = new Date();
    const next = findNext();
    if (!next) return;

    if (next.id !== state.lastNextId) {
      dom.nextName.textContent = LABELS[next.prayer];
      dom.nextAt.textContent = "à " + hm(next.at);
      state.lastNextId = next.id;
      renderRows();
      updateNightMode();
    }

    let s = Math.max(0, Math.floor((next.at - now) / 1000));
    const txt = String(Math.floor(s / 3600)).padStart(2, "0") + ":" +
                String(Math.floor((s % 3600) / 60)).padStart(2, "0") + ":" +
                String(s % 60).padStart(2, "0");
    if (txt !== state.lastCount) { dom.count.textContent = txt; state.lastCount = txt; }

    const prev = findPrev();
    if (prev) {
      const total = next.at - prev.at;
      const done = Math.min(1, Math.max(0, (now - prev.at) / total));
      dom.progFill.style.width = (done * 100).toFixed(2) + "%";
      dom.progFrom.textContent = LABELS[prev.prayer] + " " + hm(prev.at);
      dom.progTo.textContent = LABELS[next.prayer] + " " + hm(next.at);
    }
  }

  function updateNightMode() {
    const prev = findPrev();
    const night = !!prev && prev.prayer === "isha";
    if (night !== dom.app.classList.contains("is-night")) dom.app.classList.toggle("is-night", night);
  }

  // ---------- Aujourd'hui : la course du soleil -------------------------
  // Le sujet même de l'app : la position du soleil. La ligne pointillée des
  // -18° est celle de la nuit noire — entre le 26 mai et le 16 juillet on
  // VOIT la courbe ne pas l'atteindre.
  const SKY = { w: 1000, h: 300, top: 30, bot: 46, aMax: 60, aMin: -42 };
  const altY = a => SKY.top + (SKY.aMax - Math.max(SKY.aMin, Math.min(SKY.aMax, a))) /
                    (SKY.aMax - SKY.aMin) * (SKY.h - SKY.top - SKY.bot);
  const hX = h => (h / 24) * SKY.w;

  function drawSky() {
    if (!dom.sky || !state.today) return;
    dom.sky.innerHTML = "";
    const day = new Date();
    const alt = h => PrayTimes.sunAltitude(day, cfg.latitude, cfg.longitude, undefined, h);
    const g = svg("svg", { viewBox: "0 0 " + SKY.w + " " + SKY.h, preserveAspectRatio: "none",
      role: "img", "aria-label": "Hauteur du soleil au fil de la journée" });

    let d = "";
    for (let i = 0; i <= 144; i++) {
      const h = i / 6;
      d += (i ? "L" : "M") + hX(h).toFixed(1) + " " + altY(alt(h)).toFixed(1) + " ";
    }
    const yH = altY(0), yN = altY(-18);

    g.appendChild(svg("rect", { x: 0, y: yN, width: SKY.w, height: Math.max(0, SKY.h - yN), class: "sky-night" }));
    g.appendChild(svg("path", { d: d + "L" + SKY.w + " " + SKY.h + " L0 " + SKY.h + " Z", class: "sky-fill" }));
    g.appendChild(svg("line", { x1: 0, y1: yH, x2: SKY.w, y2: yH, class: "sky-horizon" }));
    g.appendChild(svg("line", { x1: 0, y1: yN, x2: SKY.w, y2: yN, class: "sky-thresh" }));
    g.appendChild(svg("path", { d: d, class: "sky-curve" }));

    for (const p of PRAYERS) {
      const t = state.today[p];
      if (!t) continue;
      let h = t.getHours() + t.getMinutes() / 60;
      if (t.getDate() !== day.getDate()) h += 24;
      if (h > 24) h -= 24;
      const x = hX(h), y = altY(alt(h)), passed = t <= day;
      g.appendChild(svg("circle", { cx: x, cy: y, r: 9, class: "sky-dot" + (passed ? " is-passed" : "") }));
      const lab = svg("text", { x: Math.max(46, Math.min(SKY.w - 46, x)), y: y - 20,
        class: "sky-label" + (passed ? " is-passed" : "") });
      lab.textContent = LABELS[p];
      g.appendChild(lab);
    }

    const nh = day.getHours() + day.getMinutes() / 60;
    g.appendChild(svg("line", { x1: hX(nh), y1: 0, x2: hX(nh), y2: SKY.h, class: "sky-now" }));
    g.appendChild(svg("circle", { cx: hX(nh), cy: altY(alt(nh)), r: 13, class: "sky-sun" }));
    dom.sky.appendChild(g);
  }

  // ---------- Qibla ------------------------------------------------------
  function renderQibla() {
    const bearing = PrayTimes.qiblaBearing(cfg.latitude, cfg.longitude);
    dom.qiblaDeg.textContent = bearing.toFixed(0) + "° " + compassName(bearing);

    dom.qiblaDial.innerHTML = "";
    const g = svg("svg", { viewBox: "0 0 200 200", role: "img",
      "aria-label": "Direction de la Qibla : " + bearing.toFixed(0) + " degrés" });

    // Le cadran tourne avec la boussole ; l'aiguille, elle, reste sur la Qibla.
    const rotor = svg("g", { id: "qibla-rotor" });
    rotor.appendChild(svg("circle", { cx: 100, cy: 100, r: 92, class: "qd-ring" }));
    for (let a = 0; a < 360; a += 15) {
      const long = a % 90 === 0, r1 = long ? 74 : 82;
      const rad = (a - 90) * Math.PI / 180;
      rotor.appendChild(svg("line", {
        x1: 100 + Math.cos(rad) * r1, y1: 100 + Math.sin(rad) * r1,
        x2: 100 + Math.cos(rad) * 88, y2: 100 + Math.sin(rad) * 88, class: "qd-tick" }));
    }
    [["N", 0], ["E", 90], ["S", 180], ["O", 270]].forEach(function (c) {
      const rad = (c[1] - 90) * Math.PI / 180;
      const t = svg("text", { x: 100 + Math.cos(rad) * 60, y: 100 + Math.sin(rad) * 60 + 5,
        class: "qd-card" + (c[0] === "N" ? " n" : "") });
      t.textContent = c[0];
      rotor.appendChild(t);
    });
    g.appendChild(rotor);

    const needle = svg("g", { transform: "rotate(" + bearing.toFixed(1) + " 100 100)" });
    needle.appendChild(svg("path", { d: "M100 22 L114 104 L100 96 L86 104 Z", class: "qd-needle" }));
    needle.appendChild(svg("path", { d: "M100 178 L88 104 L100 112 L112 104 Z", class: "qd-tail" }));
    g.appendChild(needle);
    g.appendChild(svg("circle", { cx: 100, cy: 100, r: 9, class: "qd-hub" }));

    dom.qiblaDial.appendChild(g);
    applyHeading();
  }

  function compassName(b) {
    const n = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
    return "vers le " + n[Math.round(b / 45) % 8];
  }

  function applyHeading() {
    const rotor = document.getElementById("qibla-rotor");
    if (!rotor) return;
    if (state.heading === null) {
      dom.qiblaHint.textContent =
        "Oriente-toi avec une boussole : l'aiguille indique " +
        PrayTimes.qiblaBearing(cfg.latitude, cfg.longitude).toFixed(0) + "° depuis le nord.";
      return;
    }
    rotor.setAttribute("transform", "rotate(" + (-state.heading).toFixed(1) + " 100 100)");
    dom.qiblaHint.textContent = "Tourne-toi jusqu'à ce que l'aiguille pointe vers le haut.";
  }

  function startCompass() {
    const grant = function () {
      window.addEventListener("deviceorientationabsolute", onOrient, true);
      window.addEventListener("deviceorientation", onOrient, true);
      dom.btnCompass.textContent = "Boussole activée";
      setTimeout(function () {
        if (state.heading === null) {
          dom.qiblaHint.textContent =
            "Cet appareil ne fournit pas de cap. L'angle reste juste : " +
            "utilise une boussole classique.";
        }
      }, 2500);
    };
    // iOS exige une demande explicite, déclenchée par un geste.
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission()
        .then(r => { if (r === "granted") grant(); else dom.qiblaHint.textContent = "Accès à la boussole refusé."; })
        .catch(() => { dom.qiblaHint.textContent = "Boussole indisponible sur cet appareil."; });
    } else if (window.DeviceOrientationEvent) {
      grant();
    } else {
      dom.qiblaHint.textContent = "Cet appareil n'a pas de boussole.";
    }
  }

  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === "number") h = 360 - e.alpha;
    if (h === null || isNaN(h)) return;
    state.heading = h;
    applyHeading();
  }

  // ---------- Mois -------------------------------------------------------
  function renderMonth() {
    const c = state.monthCursor || new Date();
    state.monthCursor = c;
    dom.monthLabel.textContent = c.toLocaleDateString("fr-BE", { month: "long", year: "numeric" });

    const t = dom.monthTable;
    t.innerHTML = "";
    const head = el("tr");
    ["Jour", "Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"].forEach(h => head.appendChild(el("th", null, h)));
    const thead = document.createElement("thead"); thead.appendChild(head); t.appendChild(thead);

    const body = document.createElement("tbody");
    const todayKey = dayKey(new Date());
    const last = new Date(c.getFullYear(), c.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= last; d++) {
      const day = new Date(c.getFullYear(), c.getMonth(), d);
      const tm = timesFor(day);
      const tr = el("tr");
      if (dayKey(day) === todayKey) tr.classList.add("is-today");
      tr.appendChild(el("td", null, String(d).padStart(2, "0") + " " +
        day.toLocaleDateString("fr-BE", { weekday: "short" })));
      for (const p of PRAYERS) tr.appendChild(el("td", null, hm(tm[p])));
      body.appendChild(tr);
    }
    t.appendChild(body);
  }

  function shiftMonth(n) {
    const c = state.monthCursor || new Date();
    state.monthCursor = new Date(c.getFullYear(), c.getMonth() + n, 1);
    renderMonth();
  }

  // ---------- Onglets ----------------------------------------------------
  function showView(name) {
    state.view = name;
    for (const v of ["today", "track", "qibla", "month", "settings"]) {
      document.getElementById("view-" + v).classList.toggle("hidden", v !== name);
    }
    for (const t of dom.tabs) t.classList.toggle("is-active", t.dataset.view === name);
    dom.views.scrollTop = 0;
    if (name === "track") renderTrack();
    if (name === "qibla") renderQibla();
    if (name === "month") renderMonth();
    if (name === "settings") fillSettingsForm();
  }

  // ---------- Compteur de dhikr ------------------------------------------
  // Les trois formules de la tasbih qui suit la prière, plus un mode libre.
  const DHIKRS = [
    { id: "subhan", ar: "سُبْحَانَ ٱللَّٰه",  fr: "SubhanAllah",  goal: 33 },
    { id: "hamd",   ar: "ٱلْحَمْدُ لِلَّٰه", fr: "Alhamdulillah", goal: 33 },
    { id: "akbar",  ar: "ٱللَّٰهُ أَكْبَر",   fr: "Allahu Akbar",  goal: 34 },
    { id: "libre",  ar: "ذِكْر",             fr: "Libre",         goal: 0  }
  ];
  const DHIKR_KEY = "adhan.dhikr.v1";
  let dhikr = { day: "", cur: "subhan", counts: {}, total: 0 };
  let dhikrUndo = null;

  function loadDhikr() {
    try { dhikr = JSON.parse(localStorage.getItem(DHIKR_KEY)) || dhikr; } catch (e) {}
    const k = dayKey(new Date());
    if (dhikr.day !== k) { dhikr = { day: k, cur: dhikr.cur || "subhan", counts: {}, total: 0 }; }
    if (!dhikr.counts) dhikr.counts = {};
  }
  function saveDhikr() {
    try { localStorage.setItem(DHIKR_KEY, JSON.stringify(dhikr)); }
    catch (e) { log("Dhikr non enregistrable : " + e.message); }
  }

  const curDhikr = () => DHIKRS.find(d => d.id === dhikr.cur) || DHIKRS[0];
  const curCount = () => dhikr.counts[dhikr.cur] || 0;

  function renderDhikr() {
    const d = curDhikr(), n = curCount();
    dom.dhikrArabic.textContent = d.ar;
    dom.dhikrName.textContent = d.fr;
    dom.dhikrCount.textContent = String(n);
    dom.dhikrGoal.textContent = d.goal ? "sur " + d.goal : "sans objectif";
    dom.dhikrRing.style.width = d.goal ? Math.min(100, n / d.goal * 100) + "%" : "0%";
    dom.dhikrTap.classList.toggle("is-complete", !!d.goal && n >= d.goal);
    dom.dhikrTotal.textContent = dhikr.total + " aujourd'hui";
    if (dom.dhikrToday) dom.dhikrToday.textContent = dhikr.total + " aujourd'hui";
    for (const b of dom.dhikrPresetBtns) b.classList.toggle("is-on", b.dataset.id === dhikr.cur);
  }

  function tapDhikr() {
    const d = curDhikr();
    const before = curCount();
    dhikr.counts[dhikr.cur] = before + 1;
    dhikr.total += 1;
    saveDhikr();
    renderDhikr();
    // Retour haptique court. Plus marqué quand l'objectif est atteint : c'est
    // l'information qu'on attend, et elle arrive sans qu'on ait à lire.
    try {
      if (navigator.vibrate) {
        navigator.vibrate(d.goal && before + 1 === d.goal ? [60, 50, 60, 50, 120] : 12);
      }
    } catch (e) {}
  }

  function resetDhikr() {
    // Remise à zéro immédiate + ANNULER, plutôt qu'une confirmation : perdre
    // 90 récitations sur une fausse manœuvre serait cruel, et une popup de
    // confirmation finit par se cliquer sans lire.
    dhikrUndo = { id: dhikr.cur, n: curCount() };
    dhikr.total = Math.max(0, dhikr.total - curCount());
    dhikr.counts[dhikr.cur] = 0;
    saveDhikr(); renderDhikr();
    dom.dhikrUndoBtn.classList.remove("hidden");
    setTimeout(() => dom.dhikrUndoBtn.classList.add("hidden"), 8000);
  }

  function undoDhikr() {
    if (!dhikrUndo) return;
    dhikr.counts[dhikrUndo.id] = dhikrUndo.n;
    dhikr.total += dhikrUndo.n;
    dhikrUndo = null;
    saveDhikr(); renderDhikr();
    dom.dhikrUndoBtn.classList.add("hidden");
  }

  function openDhikr() {
    loadDhikr();
    dom.dhikr.classList.remove("hidden");
    renderDhikr();
    keepScreenOn();
  }
  function closeDhikr() { dom.dhikr.classList.add("hidden"); renderTrack(); }

  function buildDhikrPresets() {
    dom.dhikrPresets.innerHTML = "";
    dom.dhikrPresetBtns = [];
    for (const d of DHIKRS) {
      const b = el("button", "dhikr-preset", d.fr + (d.goal ? " · " + d.goal : ""));
      b.type = "button"; b.dataset.id = d.id;
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        dhikr.cur = d.id; saveDhikr(); renderDhikr();
      });
      dom.dhikrPresets.appendChild(b);
      dom.dhikrPresetBtns.push(b);
    }
  }

  // ---------- Rappel personnel après l'adhan -----------------------------
  // ⚠️ Ce n'est PAS une iqama. L'iqama est décidée par une mosquée et ne se
  // calcule pas ; ceci est un délai que l'utilisateur se fixe à lui-même.
  let reminderTimer = null;

  function showReminder(prayer, at) {
    dom.remTitle.textContent = "Il est temps de prier " + LABELS[prayer];
    dom.remSub.textContent = "L'adhan a retenti à " + hm(at) + ".";
    dom.reminder.classList.remove("hidden");
    // Vibration courte si l'appareil sait le faire — un rappel qu'on sent
    // sans qu'il fasse de bruit.
    try { if (navigator.vibrate) navigator.vibrate([90, 60, 90]); } catch (e) {}
    if (reminderTimer) clearTimeout(reminderTimer);
    reminderTimer = setTimeout(hideReminder, 90000);   // se referme seul
    log("Rappel affiché pour " + prayer);
  }

  function hideReminder() {
    if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
    dom.reminder.classList.add("hidden");
  }

  // ---------- Déclenchement de secours (l'app au premier plan) -----------
  function tickSlow() {
    refreshDailyCache();
    const now = new Date();
    const win = cfg.triggerWindowMinutes * 60 * 1000;

    for (const e of state.schedule) {
      if (cfg.prayersWithAdhan.indexOf(e.prayer) === -1) continue;

      const late = now - e.at;
      if (late >= 0 && late < win && !state.fired[e.id]) {
        state.fired[e.id] = true;
        log("Déclenchement depuis l'écran : " + e.prayer);
        switchToAlarm(e.prayer, true);
        return;
      }

      // Le rappel suit le même principe que le déclenchement : une fenêtre
      // de tolérance, et une seule fois. Il ne se déclenche que pour les
      // prières qui sonnent, et jamais si la prière est déjà accomplie.
      const delay = cfg.reminderMinutes || 0;
      if (!delay) continue;
      const dueAt = +e.at + delay * 60000;
      const lateRem = now - dueAt;
      if (lateRem >= 0 && lateRem < win && !state.reminded[e.id]) {
        state.reminded[e.id] = true;
        if (isDone(e.id.split(":")[0], e.prayer)) continue;   // déjà priée
        showReminder(e.prayer, e.at);
      }
    }
  }

  function startTimers() {
    stopTimers();
    tickFast(); tickSlow();
    state.fastTimer = setInterval(tickFast, 1000);
    state.slowTimer = setInterval(function () { tickSlow(); drawSky(); }, 30000);
  }
  function stopTimers() {
    if (state.fastTimer) { clearInterval(state.fastTimer); state.fastTimer = null; }
    if (state.slowTimer) { clearInterval(state.slowTimer); state.slowTimer = null; }
  }

  // ---------- Alarme -----------------------------------------------------
  let alarmTimeout = null, fromScreen = false, loadedSrc = null, wakeLock = null;

  function keepScreenOn() {
    if (!navigator.wakeLock || wakeLock) return;
    navigator.wakeLock.request("screen")
      .then(w => { wakeLock = w; w.addEventListener("release", () => { wakeLock = null; }); })
      .catch(() => {});
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stopTimers();
    else { startTimers(); keepScreenOn(); }
  });

  function switchToAlarm(prayer, screenTriggered) {
    fromScreen = !!screenTriggered;
    stopTimers();
    dom.alarm.classList.remove("hidden");
    dom.alarmName.textContent = LABELS[prayer] || prayer;
    dom.alarmTime.textContent = hm(new Date());

    const a = dom.alarmAudio;
    if (loadedSrc !== cfg.adhanFile) { a.src = cfg.adhanFile; loadedSrc = cfg.adhanFile; }
    else a.currentTime = 0;
    a.volume = 1;
    const pr = a.play();
    if (pr && pr.catch) pr.catch(e => log("Lecture audio impossible : " + e.message));

    if (alarmTimeout) clearTimeout(alarmTimeout);
    alarmTimeout = setTimeout(closeAlarm, cfg.alarmAutoCloseSeconds * 1000);
    a.onended = closeAlarm;
    dom.alarmStop.focus();
  }

  function closeAlarm() {
    if (alarmTimeout) { clearTimeout(alarmTimeout); alarmTimeout = null; }
    try { dom.alarmAudio.pause(); dom.alarmAudio.currentTime = 0; } catch (e) {}
    dom.alarm.classList.add("hidden");
    // On relance TOUJOURS les timers avant de tenter de fermer l'app : si la
    // fermeture échoue, l'écran resterait figé.
    startTimers();
    if (!fromScreen) {
      try {
        if (window.webOS && typeof webOS.platformBack === "function") webOS.platformBack();
        else if (typeof window.close === "function") window.close();
      } catch (e) { log("Fermeture impossible : " + e.message); }
    }
  }

  // Relance par le service quand l'app tourne déjà : sans ce gestionnaire,
  // l'adhan demandé ne partirait pas.
  document.addEventListener("webOSRelaunch", function (e) {
    let p = null;
    try { p = e && e.detail ? (typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail) : null; }
    catch (err) { p = null; }
    if (p && p.mode === "alarm" && p.prayer) switchToAlarm(p.prayer, false);
  });

  // ---------- Réglages ---------------------------------------------------
  function buildToggles() {
    dom.setPrayers.innerHTML = "";
    for (const p of PRAYERS) {
      const lab = el("label", "set-toggle");
      const i = document.createElement("input");
      i.type = "checkbox"; i.value = p;
      lab.appendChild(i);
      lab.appendChild(el("span", "box"));
      lab.appendChild(el("span", null, LABELS[p]));
      dom.setPrayers.appendChild(lab);
    }
  }

  function fillSettingsForm() {
    if (!dom.setPlace) return;
    dom.setPlace.value = cfg.placeName || "";
    dom.setLat.value = cfg.latitude;
    dom.setLng.value = cfg.longitude;
    dom.setFajr.value = cfg.fajrAngle;
    dom.setIsha.value = cfg.ishaAngle;
    dom.setAsr.value = cfg.asrMethod;
    dom.setHigh.value = cfg.highLats;
    dom.setReminder.value = String(cfg.reminderMinutes);
    const on = cfg.prayersWithAdhan || [];
    dom.setPrayers.querySelectorAll("input").forEach(i => { i.checked = on.indexOf(i.value) !== -1; });
    dom.setStore.textContent = (store === "service")
      ? "Réglages détenus par le service de fond — c'est lui qui déclenche l'adhan."
      : "Réglages enregistrés dans cet appareil.";
    showErrors(null);
    updatePreview();
  }

  function readForm() {
    const on = [];
    dom.setPrayers.querySelectorAll("input").forEach(i => { if (i.checked) on.push(i.value); });
    const num = elm => elm.value.trim() === "" ? NaN : Number(elm.value);
    return {
      placeName: dom.setPlace.value.trim(),
      latitude: num(dom.setLat), longitude: num(dom.setLng),
      fajrAngle: num(dom.setFajr), ishaAngle: num(dom.setIsha),
      asrMethod: dom.setAsr.value, highLats: dom.setHigh.value,
      reminderMinutes: Number(dom.setReminder.value),
      prayersWithAdhan: on
    };
  }

  function showErrors(errors) {
    if (!errors || !Object.keys(errors).length) {
      dom.setErrors.classList.add("hidden"); dom.setErrors.textContent = ""; return;
    }
    dom.setErrors.textContent = Object.keys(errors).map(k => "• " + errors[k]).join("\n");
    dom.setErrors.classList.remove("hidden");
  }

  // Aperçu sur la nuit la plus courte : c'est le jour où les conventions
  // divergent le plus. Un 21 décembre ne prouverait rien.
  function updatePreview() {
    const v = S.validate(readForm());
    const test = S.effective(DEFAULTS, Object.assign({}, overrides, v.values));
    try {
      const t = PrayTimes.getTimesAsDates(new Date(new Date().getFullYear(), 5, 21),
        test.latitude, test.longitude, undefined, S.ptOptions(test));
      dom.setPreview.textContent = "Le 21 juin, ces réglages donneraient : Fajr " +
        hm(t.fajr) + " · Maghrib " + hm(t.maghrib) + " · Isha " + hm(t.isha) + ".";
    } catch (e) { dom.setPreview.textContent = "Aperçu indisponible : " + e.message; }
  }

  function saveSettings() {
    const v = S.validate(readForm());
    if (!v.ok) { showErrors(v.errors); return; }
    const next = S.diff(DEFAULTS, S.effective(DEFAULTS, Object.assign({}, overrides, v.values)));
    persistSettings(next, function (ok, err) {
      if (!ok) {
        showErrors({ stockage: "Enregistrement impossible" + (err ? " (" + err + ")" : "") +
          ". Les réglages restent ceux d'avant." });
        return;
      }
      applyOverrides(next);
      refreshDailyCache();
      log("Réglages enregistrés (" + store + ")");
      showView("today");
    });
  }

  function resetSettings() {
    persistSettings({}, function (ok, err) {
      if (!ok) { showErrors({ stockage: "Remise à zéro impossible" + (err ? " (" + err + ")" : "") + "." }); return; }
      applyOverrides({}); refreshDailyCache(); fillSettingsForm();
      log("Réglages remis aux valeurs d'origine");
    });
  }

  function locate() {
    if (!navigator.geolocation) {
      showErrors({ position: "Cet appareil ne sait pas donner sa position. Saisir les coordonnées à la main." });
      return;
    }
    dom.btnLocate.textContent = "Recherche…";
    navigator.geolocation.getCurrentPosition(function (pos) {
      dom.setLat.value = pos.coords.latitude.toFixed(4);
      dom.setLng.value = pos.coords.longitude.toFixed(4);
      dom.btnLocate.textContent = "Utiliser ma position";
      showErrors(null); updatePreview();
    }, function (err) {
      dom.btnLocate.textContent = "Utiliser ma position";
      showErrors({ position: "Position indisponible (" + err.message +
        "). Le navigateur l'interdit hors https ; saisir les coordonnées à la main." });
    }, { timeout: 10000, maximumAge: 0 });
  }

  // ---------- Service de fond -------------------------------------------
  function startBackgroundService() {
    if (!window.webOS || !webOS.service) return;
    try {
      webOS.service.request("luna://" + cfg.serviceName, {
        method: "start", parameters: {},
        onSuccess: r => log("Service OK"), onFailure: e => log("Service en échec")
      });
    } catch (e) { log("Exception service : " + e.message); }
  }

  // ---------- Démarrage --------------------------------------------------
  function init() {
    const g = id => document.getElementById(id);
    dom.app = g("app"); dom.views = g("views"); dom.alarm = g("alarm");
    dom.placeName = g("place-name"); dom.qiblaPlace = g("qibla-place");
    dom.dateHijri = g("date-hijri"); dom.dateGreg = g("date-greg");
    dom.nextName = g("next-prayer-name"); dom.nextAt = g("next-prayer-at");
    dom.count = g("next-prayer-countdown");
    dom.progFill = g("progress-fill"); dom.progFrom = g("progress-from"); dom.progTo = g("progress-to");
    dom.rows = g("prayer-rows"); dom.sky = g("sky");
    dom.qiblaDial = g("qibla-dial"); dom.qiblaDeg = g("qibla-deg"); dom.qiblaHint = g("qibla-hint");
    dom.btnCompass = g("btn-compass");
    dom.monthLabel = g("month-label"); dom.monthTable = g("month-table");
    dom.alarmName = g("alarm-prayer-name"); dom.alarmTime = g("alarm-time");
    dom.alarmStop = g("alarm-stop"); dom.alarmAudio = g("alarm-audio");
    dom.trackToday = g("track-today"); dom.trackGrid = g("track-grid");
    dom.statRate = g("stat-rate"); dom.statStreak = g("stat-streak"); dom.statTotal = g("stat-total");
    dom.dhikr = g("dhikr"); dom.dhikrTap = g("dhikr-tap");
    dom.dhikrArabic = g("dhikr-arabic"); dom.dhikrName = g("dhikr-name");
    dom.dhikrCount = g("dhikr-count"); dom.dhikrGoal = g("dhikr-goal");
    dom.dhikrRing = g("dhikr-ring-fill"); dom.dhikrTotal = g("dhikr-total");
    dom.dhikrPresets = g("dhikr-presets"); dom.dhikrUndoBtn = g("dhikr-undo");
    dom.dhikrToday = g("dhikr-today");
    dom.reminder = g("reminder"); dom.remTitle = g("reminder-title"); dom.remSub = g("reminder-sub");
    dom.setReminder = g("set-reminder");
    dom.logArea = g("log-area");
    dom.setPrayers = g("set-prayers"); dom.setPlace = g("set-place");
    dom.setLat = g("set-lat"); dom.setLng = g("set-lng");
    dom.setFajr = g("set-fajr-angle"); dom.setIsha = g("set-isha-angle");
    dom.setAsr = g("set-asr"); dom.setHigh = g("set-highlats");
    dom.setPreview = g("set-preview"); dom.setErrors = g("set-errors"); dom.setStore = g("set-store");
    dom.btnLocate = g("btn-locate");
    dom.tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));

    loadTracking();
    loadDhikr();
    buildDhikrPresets();
    buildToggles();

    for (const t of dom.tabs) t.addEventListener("click", () => showView(t.dataset.view));
    g("btn-test").addEventListener("click", () => switchToAlarm("test", true));
    dom.alarmStop.addEventListener("click", closeAlarm);
    dom.btnCompass.addEventListener("click", startCompass);
    dom.dhikrTap.addEventListener("click", tapDhikr);
    g("dhikr-close").addEventListener("click", closeDhikr);
    g("dhikr-reset").addEventListener("click", resetDhikr);
    dom.dhikrUndoBtn.addEventListener("click", undoDhikr);
    g("btn-dhikr").addEventListener("click", openDhikr);
    g("reminder-close").addEventListener("click", hideReminder);
    dom.reminder.addEventListener("click", hideReminder);
    g("month-prev").addEventListener("click", () => shiftMonth(-1));
    g("month-next").addEventListener("click", () => shiftMonth(1));
    g("btn-set-save").addEventListener("click", saveSettings);
    g("btn-set-cancel").addEventListener("click", () => showView("today"));
    g("btn-set-reset").addEventListener("click", resetSettings);
    g("btn-toggle-log").addEventListener("click", () => dom.logArea.classList.toggle("visible"));
    dom.btnLocate.addEventListener("click", locate);
    ["set-lat", "set-lng", "set-fajr-angle", "set-isha-angle", "set-asr", "set-highlats", "set-reminder"]
      .forEach(id => { g(id).addEventListener("input", updatePreview); g(id).addEventListener("change", updatePreview); });

    document.addEventListener("keydown", function (e) {
      if (e.keyCode !== 27 && e.keyCode !== 461) return;
      if (!dom.alarm.classList.contains("hidden")) { closeAlarm(); e.preventDefault(); }
      else if (!dom.dhikr.classList.contains("hidden")) { closeDhikr(); e.preventDefault(); }
    });

    let params = {};
    try {
      if (window.PalmSystem && window.PalmSystem.launchParams) params = JSON.parse(window.PalmSystem.launchParams);
    } catch (e) {}
    const hash = location.hash.replace("#", "");
    if (hash.indexOf("alarm=") === 0) params = { mode: "alarm", prayer: hash.split("=")[1].toLowerCase() };

    loadSettings(function () {
      log("Réglages : " + store + " · " + (cfg.placeName || "?") + " " +
          cfg.latitude + "/" + cfg.longitude + " · " +
          PT_OPTS.fajrAngle + "°/" + PT_OPTS.ishaAngle + "° · " + PT_OPTS.highLats);
      refreshDailyCache();
      if (params.mode === "alarm" && params.prayer) {
        switchToAlarm(params.prayer, false);
      } else {
        startTimers();
        startBackgroundService();
        keepScreenOn();
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
