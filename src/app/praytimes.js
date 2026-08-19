// =====================================================================
// PrayTimes — calculateur d'horaires de prière pour Adhan TV
//
// Algorithme d'après http://praytimes.org/calculation (Hamid Zarrabi-Zadeh).
// Ceci est une RÉIMPLÉMENTATION indépendante, pas une copie de PrayTimes.js.
// Recoupée avec PrayTimes.org v2.5 : écart maximum 1,05 minute sur le lever,
// Dhuhr, Asr et Maghrib, sur les 365 jours de l'année, à 50,84° N.
//
// Autonome, sans dépendance.
//
// ⚠️ CE FICHIER EXISTE EN DEUX EXEMPLAIRES (src/app et src/service) parce que
// webOS empaquette l'interface et le service séparément. Les deux copies
// DOIVENT rester identiques — `npm test` échoue si elles divergent.
// =====================================================================

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.PrayTimes = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  // Angles de méthode, en degrés sous l'horizon.
  // `ishaMinutes` (Makkah) = décalage fixe en MINUTES après Maghrib, pas un angle.
  const METHODS = {
    MWL:      { fajr: 18,   isha: 17   },
    ISNA:     { fajr: 15,   isha: 15   },
    Egyptian: { fajr: 19.5, isha: 17.5 },
    Karachi:  { fajr: 18,   isha: 18   },
    Makkah:   { fajr: 18.5, ishaMinutes: 90 }
  };

  function dtr(d) { return (d * Math.PI) / 180; }
  function rtd(r) { return (r * 180) / Math.PI; }
  function fixHour(h) { h = h - 24 * Math.floor(h / 24); return h < 0 ? h + 24 : h; }
  function fixAngle(a) { a = a - 360 * Math.floor(a / 360); return a < 0 ? a + 360 : a; }

  function julianDay(year, month, day) {
    if (month <= 2) { year -= 1; month += 12; }
    const A = Math.floor(year / 100);
    const B = 2 - A + Math.floor(A / 4);
    return Math.floor(365.25 * (year + 4716)) +
           Math.floor(30.6001 * (month + 1)) +
           day + B - 1524.5;
  }

  function sunPosition(jd) {
    const D = jd - 2451545.0;
    const g = fixAngle(357.529 + 0.98560028 * D);
    const q = fixAngle(280.459 + 0.98564736 * D);
    const L = fixAngle(q + 1.915 * Math.sin(dtr(g)) + 0.020 * Math.sin(dtr(2 * g)));
    const e = 23.439 - 0.00000036 * D;
    const RA = rtd(Math.atan2(
      Math.cos(dtr(e)) * Math.sin(dtr(L)),
      Math.cos(dtr(L))
    )) / 15;
    const decl = rtd(Math.asin(Math.sin(dtr(e)) * Math.sin(dtr(L))));
    // Équation du temps. Elle ne vaut jamais plus de ±16 minutes ; mais autour
    // de l'équinoxe de mars l'ascension droite du soleil franchit 0 h, et
    // fixHour() la fait alors sauter de 24 heures. On ramène donc l'écart dans
    // [-12, +12]. Sans ça, Dhuhr vaut -11 h au lieu de 12 h fin mars.
    let eqt = q / 15 - fixHour(RA);
    eqt = eqt - 24 * Math.round(eqt / 24);
    return { decl: decl, eqt: eqt };
  }

  // Angle horaire pour une altitude solaire donnée sous l'horizon.
  function computeTime(angle, lat, decl) {
    const num = -Math.sin(dtr(angle)) - Math.sin(dtr(lat)) * Math.sin(dtr(decl));
    const den = Math.cos(dtr(lat)) * Math.cos(dtr(decl));
    const cosH = num / den;
    if (cosH > 1 || cosH < -1) return NaN; // le soleil n'atteint jamais cet angle
    return rtd(Math.acos(cosH)) / 15;
  }

  // Asr : angle pour lequel l'ombre = facteur × objet + ombre de midi.
  function asrTime(lat, decl, factor) {
    const angle = -rtd(Math.atan(1 / (factor + Math.tan(dtr(Math.abs(lat - decl))))));
    return computeTime(angle, lat, decl);
  }

  // Heures décimales -> "HH:MM". Ramène dans 0-24 : un Isha à 24,12 s'affiche
  // bien "00:07", ce qui est l'heure murale correcte.
  function formatHM(h) {
    if (h === null || h === undefined || isNaN(h)) return "--:--";
    const r = fixHour(h + 0.5 / 60); // arrondi à la minute
    const hh = Math.floor(r);
    const mm = Math.floor((r - hh) * 60);
    return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
  }

  // ---------------------------------------------------------------------
  // Fuseau horaire
  // ---------------------------------------------------------------------
  // Décalage en heures POUR LA DATE VISÉE, lu à 12 h locales — la seule heure
  // de la journée qui n'est jamais ni sautée ni répétée par un changement
  // d'heure.
  //
  // ⚠️ L'ancienne version lisait le décalage « maintenant ». Les deux dimanches
  // de bascule, le cache journalier était construit à 1 h ou 2 h du matin, donc
  // AVANT le changement, et figeait l'ancien fuseau pour toute la journée :
  // l'adhan partait 1 h trop tôt le 29 mars et 1 h trop tard le 25 octobre.
  function tzOffsetForDate(date) {
    const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
    return -noon.getTimezoneOffset() / 60;
  }

  // ---------------------------------------------------------------------
  // Règle des hautes latitudes
  // ---------------------------------------------------------------------
  // Portion de nuit accordée à Fajr / Isha selon la règle choisie.
  function nightPortion(rule, angle, night) {
    if (rule === "NightMiddle") return night / 2;
    if (rule === "OneSeventh")  return night / 7;
    return (angle / 60) * night;               // "AngleBased" (défaut)
  }

  // Portage fidèle de adjustHLTime() de PrayTimes.org v2.5 : l'heure est
  // plafonnée dès qu'elle s'éloigne de sa base de PLUS que la portion de nuit
  // autorisée — pas seulement quand elle est indéfinie.
  //
  // ⚠️ L'ancienne version comparait à une nuit ENTIÈRE (`times.sunrise - night`),
  // condition qui ne se déclenchait jamais. Le repli n'agissait donc que sur les
  // valeurs NaN, d'où un saut brutal de 74 minutes sur le Fajr entre le 25 mai
  // (02:02) et le 26 mai (03:16), et 100 jours par an hors référence.
  function adjustHighLat(times, angles, rule) {
    const night = fixHour(times.sunrise - times.sunset); // coucher -> lever suivant

    const fajrPortion = nightPortion(rule, angles.fajr, night);
    if (isNaN(times.fajr) || fixHour(times.sunrise - times.fajr) > fajrPortion) {
      times.fajr = times.sunrise - fajrPortion;
    }

    // Un Isha défini en minutes après Maghrib (Makkah) ne peut pas être
    // indéfini et n'a pas d'angle : la règle ne s'y applique pas.
    if (angles.ishaMinutes === undefined) {
      const ishaPortion = nightPortion(rule, angles.isha, night);
      if (isNaN(times.isha) || fixHour(times.isha - times.sunset) > ishaPortion) {
        times.isha = times.sunset + ishaPortion;
      }
    }
    return times;
  }

  // ---------------------------------------------------------------------
  // API principale
  // ---------------------------------------------------------------------
  // date     : objet Date (seule la date locale est lue)
  // lat, lng : degrés
  // tzOffset : heures depuis UTC. Laisser undefined = calculé pour la date.
  // opts     : { method, asrFactor, highLats, fajrAngle, ishaAngle }
  //
  // ⚠️ Les heures retournées sont CONTINUES et ancrées sur la date demandée :
  // un Isha qui tombe après minuit vaut par exemple 24,12 (et non 0,12). C'est
  // volontaire — c'est ce qui permet de le comparer et de le classer
  // correctement. Utiliser formatHM() pour l'affichage, ou getTimesAsDates()
  // pour obtenir des instants absolus.
  function getTimes(date, lat, lng, tzOffset, opts) {
    opts = opts || {};
    const base = METHODS[opts.method] || METHODS.MWL;

    // Angles explicites prioritaires sur ceux de la méthode.
    const angles = {
      fajr: opts.fajrAngle != null ? opts.fajrAngle : base.fajr,
      isha: opts.ishaAngle != null ? opts.ishaAngle : base.isha,
      ishaMinutes: opts.ishaAngle != null ? undefined : base.ishaMinutes
    };

    const asrFactor = opts.asrFactor || 1;              // 1 = Shafi'i, 2 = Hanafi
    const rule = opts.highLats || "AngleBased";
    if (tzOffset === undefined || tzOffset === null) tzOffset = tzOffsetForDate(date);

    const jd = julianDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
    const sun = sunPosition(jd + 0.5 - lng / 360);      // position à midi solaire

    const dhuhr   = 12 - sun.eqt + (tzOffset - lng / 15);
    const sunrise = dhuhr - computeTime(0.833, lat, sun.decl);
    const sunset  = dhuhr + computeTime(0.833, lat, sun.decl);
    const maghrib = sunset;
    const asr     = dhuhr + asrTime(lat, sun.decl, asrFactor);
    const fajr    = dhuhr - computeTime(angles.fajr, lat, sun.decl);
    const isha    = angles.ishaMinutes !== undefined
      ? maghrib + angles.ishaMinutes / 60
      : dhuhr + computeTime(angles.isha, lat, sun.decl);

    let times = {
      fajr: fajr, sunrise: sunrise, dhuhr: dhuhr,
      asr: asr, sunset: sunset, maghrib: maghrib, isha: isha
    };

    if (rule !== "None") times = adjustHighLat(times, angles, rule);

    // Pas de fixHour ici : on garde l'échelle continue (voir en-tête).
    return {
      fajr:    times.fajr,
      sunrise: times.sunrise,
      dhuhr:   times.dhuhr,
      asr:     times.asr,
      maghrib: times.maghrib,
      isha:    times.isha
    };
  }

  function getTimesFormatted(date, lat, lng, tzOffset, opts) {
    const t = getTimes(date, lat, lng, tzOffset, opts);
    const out = {};
    for (const k in t) out[k] = formatHM(t[k]);
    return out;
  }

  // Mêmes horaires, mais en instants absolus (objets Date).
  //
  // C'est la forme à utiliser pour COMPARER ou DÉCLENCHER : elle règle d'un
  // coup l'Isha d'après minuit (rendu au bon jour civil, le suivant) et le
  // changement d'heure, puisque le constructeur Date respecte le fuseau local.
  function getTimesAsDates(date, lat, lng, tzOffset, opts) {
    const t = getTimes(date, lat, lng, tzOffset, opts);
    const y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
    const out = {};
    for (const k in t) {
      const h = t[k];
      if (h === null || h === undefined || isNaN(h)) { out[k] = null; continue; }
      const rounded = h + 0.5 / 60;                 // même arrondi que formatHM
      const hh = Math.floor(rounded);
      const mm = Math.floor((rounded - hh) * 60);
      // Le constructeur normalise les débordements : hh = 24 bascule bien au
      // lendemain 00:mm, en heure locale et donc en respectant l'heure d'été.
      out[k] = new Date(y, m, d, hh, mm, 0, 0);
    }
    return out;
  }

  // Hauteur du soleil au-dessus (positive) ou en dessous (négative) de
  // l'horizon, en degrés, pour une heure locale donnée. C'est ce qui permet de
  // DESSINER la journée : la courbe passe sous la ligne d'horizon la nuit, et
  // l'on voit d'un coup d'œil si elle atteint ou non les -18° du Fajr et de
  // l'Isha — le cœur du problème des nuits d'été à Bruxelles.
  function sunAltitude(date, lat, lng, tzOffset, hourLocal) {
    if (tzOffset === undefined || tzOffset === null) tzOffset = tzOffsetForDate(date);
    const jd = julianDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
    const sun = sunPosition(jd + (hourLocal - tzOffset) / 24);
    const noon = 12 - sun.eqt + (tzOffset - lng / 15);
    const H = 15 * (hourLocal - noon);              // 15° par heure
    return rtd(Math.asin(
      Math.sin(dtr(lat)) * Math.sin(dtr(sun.decl)) +
      Math.cos(dtr(lat)) * Math.cos(dtr(sun.decl)) * Math.cos(dtr(H))
    ));
  }

  // Direction de la Qibla : azimut de la Kaaba, en degrés depuis le nord vrai,
  // dans le sens des aiguilles. Calcul de grand cercle — donc juste, et local.
  const KAABA = { lat: 21.4225, lng: 39.8262 };
  function qiblaBearing(lat, lng) {
    const p1 = dtr(lat), p2 = dtr(KAABA.lat), dl = dtr(KAABA.lng - lng);
    const b = rtd(Math.atan2(
      Math.sin(dl),
      Math.cos(p1) * Math.tan(p2) - Math.sin(p1) * Math.cos(dl)
    ));
    return (b + 360) % 360;
  }

  return {
    METHODS: METHODS,
    KAABA: KAABA,
    qiblaBearing: qiblaBearing,
    sunAltitude: sunAltitude,
    getTimes: getTimes,
    getTimesFormatted: getTimesFormatted,
    getTimesAsDates: getTimesAsDates,
    formatHM: formatHM,
    fixHour: fixHour,
    tzOffsetForDate: tzOffsetForDate
  };
});
