// =====================================================================
// Adhan TV — réglages
//
// C'est LE seul fichier à modifier pour changer le lieu, la méthode de calcul
// ou les prières sonores. L'interface ET le service de fond lisent celui-ci.
//
// ⚠️ CE FICHIER EXISTE EN DEUX EXEMPLAIRES (src/app et src/service) parce que
// webOS empaquette l'interface et le service séparément. Les deux copies
// DOIVENT rester identiques — `npm test` échoue si elles divergent.
// Après avoir modifié celui-ci : `npm run sync` recopie, `npm test` vérifie.
// =====================================================================

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.ADHAN_CONFIG = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  return {
    // --- Lieu ---------------------------------------------------------
    // Position par DÉFAUT : centre de Bruxelles.
    // Chacun règle la sienne dans l'écran Réglages — elle est enregistrée sur
    // l'appareil, jamais dans ce dépôt. Un déplacement de quelques kilomètres
    // change les horaires de moins d'une minute (mesuré : 0,2 min entre le
    // centre et la périphérie de Bruxelles).
    placeName: "Bruxelles",
    latitude:  50.8503,
    longitude: 4.3517,

    // --- Calcul -------------------------------------------------------
    // Méthode de base : "MWL", "ISNA", "Egyptian", "Karachi", "Makkah".
    method: "MWL",

    // Angles en degrés sous l'horizon. S'ils sont renseignés, ils PRIMENT sur
    // ceux de `method`. Mettre à null pour utiliser ceux de la méthode.
    //
    // 18° / 18° : c'est ce que publie la Grande Mosquée de Bruxelles (méthode
    // dite « Exécutif des Musulmans de Belgique ») — vérifié le 17/08/2026, les
    // horaires concordent à la minute. C'est aussi la formule retenue par le
    // comité Ligue Islamique Mondiale + ICOP réuni à Bruxelles en 2009 pour les
    // villes situées entre 48,6° et 66,6° de latitude.
    fajrAngle: 18,
    ishaAngle: 18,

    // Asr : "Shafii" (ombre = 1 × objet) ou "Hanafi" (2 × objet).
    asrMethod: "Shafii",

    // --- Nuits d'été --------------------------------------------------
    // À Bruxelles, du 26 mai au 16 juillet, le soleil ne descend jamais à 18°
    // sous l'horizon (15,7° au maximum le 21 juin) : Fajr et Isha n'ont plus
    // de signe observable. Cette règle dit par quoi les remplacer.
    //
    //   "AngleBased"  — fraction de nuit proportionnelle à l'angle (18/60 = 30 %)
    //   "NightMiddle" — Fajr et Isha au milieu de la nuit
    //   "OneSeventh"  — un septième de la nuit de part et d'autre
    //   "None"        — aucun repli : "--:--" pendant 52 jours
    //
    // C'est un choix RELIGIEUX, pas technique. Voir AUDIT.md, annexe.
    highLats: "AngleBased",

    // --- Déclenchement ------------------------------------------------
    // Prières qui déclenchent l'adhan (les autres sont seulement affichées).
    // Fajr est exclu : la TV est en principe éteinte à cette heure-là.
    prayersWithAdhan: ["dhuhr", "asr", "maghrib", "isha"],

    // Tolérance de déclenchement, en minutes. Une prière dont l'heure est
    // passée depuis moins que ça déclenche encore ; au-delà, on ne rattrape
    // pas (personne ne veut un adhan de trois heures de retard).
    triggerWindowMinutes: 2,

    // Intervalle de vérification du service de fond, en secondes.
    pollSeconds: 30,

    // Second rappel APRÈS l'adhan, en minutes. 0 = désactivé.
    // ⚠️ Ce n'est PAS une heure d'iqama : l'iqama est décidée par chaque
    // mosquée et ne se calcule pas. Ici c'est un rappel personnel, à la
    // maison — on entend l'appel, on se dit « dans deux minutes », et ceci
    // relance. Ne jamais le présenter comme une heure de mosquée.
    reminderMinutes: 10,

    // --- Alarme -------------------------------------------------------
    adhanFile: "audio/adhan.m4a",
    alarmAutoCloseSeconds: 360,

    // --- Appareil du salon (Raspberry Pi) -----------------------------
    // Ignoré par l'app TV. Voir pi/README.md.
    //
    //   "cast"   — barre de son Samsung uniquement, par le Wi-Fi
    //   "both"   — haut-parleur local ET barre de son
    //   "local"  — haut-parleur branché sur le Pi uniquement
    //   "dryrun" — ne joue rien (tests)
    //
    // ✅ Vérifié le 18/08/2026 sur la vraie barre HW-Q990F : elle sort de veille
    // TOUTE SEULE en 2 secondes à la réception d'un flux Cast. Le haut-parleur
    // d'appoint devient donc inutile — d'où "cast" et non "both".
    // Repasser à "both" seulement si un haut-parleur local est ajouté.
    audioOutput: "cast",

    // Adresse IP de la barre de son sur le réseau local.
    // À renseigner dans Réglages, ou à trouver avec : node pi/test-cast.js
    // (elle se signale sous son nom, ex. « Q-Series Soundbar 990F »).
    // ⚠️ Une box peut réattribuer les adresses : si le son cesse un jour,
    // relancer la recherche, ou réserver l'adresse dans la box.
    // ⚠️ Le Wi-Fi (Google Cast) est le bon canal, PAS le HDMI : une barre ne
    // joue qu'une entrée à la fois, l'adhan envoyé en HDMI resterait inaudible
    // tant qu'elle est sur l'entrée TV. Cast, lui, prend la main.
    castHost: null,

    // Volume MINIMUM imposé à la barre avant de jouer l'adhan, de 0 à 1.
    // ⚠️ Trouvé le 18/08/2026, et ce n'était pas évident : Cast pilote un
    // volume PROPRE, distinct de celui de la télécommande. Il était à 11 % —
    // la barre annonçait « PLAYING », téléchargeait bien le fichier, et on
    // n'entendait rien. Panne totalement silencieuse.
    // Mettre null pour ne jamais toucher au volume de la barre.
    castMinVolume: 0.15,

    // Sortie ALSA du haut-parleur local (null = sortie par défaut du Pi).
    alsaDevice: null,

    // Port du petit serveur d'état lu par l'écran du salon.
    statusPort: 8081,

    // --- Identité de l'app (doit correspondre à appinfo.json) ----------
    appId: "com.thoubaine.adhan",
    serviceName: "com.thoubaine.adhan.service"
  };
});
