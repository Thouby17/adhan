// =====================================================================
// Réglages modifiables — couche au-dessus de config.js
//
// config.js donne les VALEURS PAR DÉFAUT (livrées avec l'app).
// Ce module applique par-dessus les préférences de l'utilisateur, valide ce
// qu'il saisit, et produit la configuration effective.
//
// ⚠️ Ce fichier ne stocke rien lui-même : il est volontairement PUR, pour être
// testable sans navigateur. C'est l'hôte qui décide où ranger les préférences
// (navigateur → localStorage ; Raspberry Pi → fichier lu par le service).
// La raison est le bug qu'on a déjà corrigé une fois : si l'écran et le
// déclencheur lisaient deux sources différentes, ils afficheraient une heure
// et en sonneraient une autre.
//
// ⚠️ CE FICHIER EXISTE EN DEUX EXEMPLAIRES (src/app et src/service).
// `npm test` échoue s'ils divergent.
// =====================================================================

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.AdhanSettings = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  const PRAYERS = ["fajr", "dhuhr", "asr", "maghrib", "isha"];

  // Seuls ces réglages sont modifiables depuis l'écran. Tout le reste
  // (identifiants d'app, chemins) reste figé dans config.js.
  const EDITABLE = [
    "latitude", "longitude", "placeName",
    "fajrAngle", "ishaAngle", "highLats", "asrMethod",
    "prayersWithAdhan", "reminderMinutes", "audioOutput", "castHost"
  ];

  const HIGH_LATS = ["AngleBased", "NightMiddle", "OneSeventh", "None"];
  const ASR = ["Shafii", "Hanafi"];
  const OUTPUTS = ["cast", "local", "both", "dryrun"];

  function isNum(v) { return typeof v === "number" && isFinite(v); }

  // Valide un lot de modifications. Rend { ok, valeurs, erreurs }.
  // Chaque message d'erreur dit CE QUI ne va pas et QUELLE valeur est attendue —
  // un « valeur invalide » sec n'aide personne.
  function validate(patch) {
    const errors = {};
    const out = {};
    patch = patch || {};

    if ("latitude" in patch) {
      const v = Number(patch.latitude);
      if (!isNum(v) || v < -90 || v > 90) {
        errors.latitude = "La latitude doit être un nombre entre -90 et 90. Bruxelles est vers 50,85.";
      } else out.latitude = v;
    }

    if ("longitude" in patch) {
      const v = Number(patch.longitude);
      if (!isNum(v) || v < -180 || v > 180) {
        errors.longitude = "La longitude doit être un nombre entre -180 et 180. Bruxelles est vers 4,35.";
      } else out.longitude = v;
    }

    if ("placeName" in patch) {
      out.placeName = String(patch.placeName || "").slice(0, 60);
    }

    for (const k of ["fajrAngle", "ishaAngle"]) {
      if (!(k in patch)) continue;
      const v = Number(patch[k]);
      if (!isNum(v) || v < 8 || v > 24) {
        errors[k] = "L'angle doit être un nombre entre 8 et 24 degrés. Les conventions courantes vont de 12 à 19,5.";
      } else out[k] = v;
    }

    if ("highLats" in patch) {
      if (HIGH_LATS.indexOf(patch.highLats) === -1) {
        errors.highLats = "Règle inconnue. Valeurs possibles : " + HIGH_LATS.join(", ") + ".";
      } else out.highLats = patch.highLats;
    }

    if ("asrMethod" in patch) {
      if (ASR.indexOf(patch.asrMethod) === -1) {
        errors.asrMethod = "Madhab inconnu. Valeurs possibles : " + ASR.join(", ") + ".";
      } else out.asrMethod = patch.asrMethod;
    }

    if ("prayersWithAdhan" in patch) {
      const list = patch.prayersWithAdhan;
      if (!Array.isArray(list) || list.some(p => PRAYERS.indexOf(p) === -1)) {
        errors.prayersWithAdhan = "Liste invalide. Valeurs possibles : " + PRAYERS.join(", ") + ".";
      } else {
        // On garde l'ordre chronologique, quel que soit l'ordre de saisie.
        out.prayersWithAdhan = PRAYERS.filter(p => list.indexOf(p) !== -1);
      }
    }

    if ("reminderMinutes" in patch) {
      const v = Number(patch.reminderMinutes);
      if (!isNum(v) || v < 0 || v > 60 || v % 1 !== 0) {
        errors.reminderMinutes = "Le rappel doit être un nombre entier de minutes, entre 0 et 60. Mettre 0 pour le désactiver.";
      } else out.reminderMinutes = v;
    }

    if ("audioOutput" in patch) {
      if (OUTPUTS.indexOf(patch.audioOutput) === -1) {
        errors.audioOutput = "Sortie inconnue. Valeurs possibles : " + OUTPUTS.join(", ") + ".";
      } else out.audioOutput = patch.audioOutput;
    }

    if ("castHost" in patch) {
      const v = patch.castHost;
      if (v === null || v === "" ) out.castHost = null;
      else if (typeof v !== "string" || !/^[\w.-]+$/.test(v)) {
        errors.castHost = "Adresse invalide. Attendu : une adresse IP du type 192.168.1.42.";
      } else out.castHost = v;
    }

    return { ok: Object.keys(errors).length === 0, values: out, errors: errors };
  }

  // Configuration effective = défauts + préférences valides.
  // Les préférences invalides sont IGNORÉES, jamais appliquées à moitié : mieux
  // vaut un réglage d'usine qu'une latitude à moitié écrite.
  function effective(defaults, overrides) {
    const cfg = {};
    for (const k in defaults) cfg[k] = defaults[k];
    const v = validate(overrides || {});
    for (const k of EDITABLE) {
      if (k in v.values) cfg[k] = v.values[k];
    }
    return cfg;
  }

  // Options de calcul dérivées, pour PrayTimes. Un seul endroit où cette
  // traduction est faite — écran et déclencheur passent tous les deux par ici.
  function ptOptions(cfg) {
    return {
      method:    cfg.method,
      fajrAngle: cfg.fajrAngle,
      ishaAngle: cfg.ishaAngle,
      asrFactor: cfg.asrMethod === "Hanafi" ? 2 : 1,
      highLats:  cfg.highLats
    };
  }

  // Ne garde que ce qui diffère des défauts : le fichier de préférences reste
  // lisible, et une évolution des défauts profite à l'utilisateur.
  function diff(defaults, cfg) {
    const out = {};
    for (const k of EDITABLE) {
      if (!(k in cfg)) continue;
      const a = JSON.stringify(cfg[k]), b = JSON.stringify(defaults[k]);
      if (a !== b) out[k] = cfg[k];
    }
    return out;
  }

  return {
    PRAYERS: PRAYERS,
    EDITABLE: EDITABLE,
    HIGH_LATS: HIGH_LATS,
    ASR: ASR,
    OUTPUTS: OUTPUTS,
    validate: validate,
    effective: effective,
    ptOptions: ptOptions,
    diff: diff
  };
});
