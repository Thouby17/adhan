// =====================================================================
// Pont vers Android — inerte partout ailleurs.
//
// Ce fichier est chargé par TOUTES les versions de l'app (navigateur, TV LG,
// fichier autonome, APK). Sur tout ce qui n'est pas l'APK, `dispo()` rend
// `false` et l'application continue exactement comme avant, avec ses propres
// minuteurs. Aucune version n'est dégradée par la présence de ce fichier.
//
// ⭐ CE QUE LE NATIF APPORTE, ET QUE LE JAVASCRIPT NE PEUT PAS FAIRE :
// une page web ne sonne que si elle est ouverte et vivante. À 5 h du matin,
// écran éteint, elle ne l'est pas. Les alarmes Android, elles, réveillent
// l'appareil. C'est toute la différence entre un affichage et un réveil.
//
// ⚠️ RÉPARTITION DES RÔLES, à ne pas brouiller :
//   - le JavaScript CALCULE les horaires (praytimes.js, source unique) ;
//   - le natif les ARME, RÉVEILLE l'écran et JOUE le son.
// Aucune heure n'est recalculée côté Java : un troisième exemplaire du moteur
// finirait par diverger, et l'écran afficherait une heure pendant que
// l'appareil en sonnerait une autre.
// =====================================================================

(function (root) {
  "use strict";

  function plugin() {
    const C = root.Capacitor;
    if (!C) return null;
    if (C.Plugins && C.Plugins.Adhan) return C.Plugins.Adhan;
    // Certaines versions n'exposent le greffon que via registerPlugin.
    if (typeof C.registerPlugin === "function") {
      try { return C.registerPlugin("Adhan"); } catch (e) { return null; }
    }
    return null;
  }

  const P = plugin();
  const dispo = !!P;

  // Toute méthode absente doit échouer PROPREMENT : sur navigateur, l'app
  // appelle ces fonctions sans se poser de question.
  function appel(nom, args) {
    if (!P || typeof P[nom] !== "function") {
      return Promise.reject(new Error("Le pont natif n'est pas disponible ici."));
    }
    try { return Promise.resolve(P[nom](args || {})); }
    catch (e) { return Promise.reject(e); }
  }

  /**
   * Construit la liste des alarmes à armer et la transmet.
   *
   * On arme SEPT JOURS d'avance, pas seulement le prochain appel. Raison
   * concrète : si personne n'ouvre l'application pendant une semaine, les
   * alarmes déjà posées continuent de sonner. Chaque déclenchement rouvre
   * l'écran, qui en reprogramme sept nouveaux — le stock se reconstitue tout
   * seul et ne s'épuise jamais.
   *
   * @param {Function} timesFor  jour → { fajr: Date, dhuhr: Date, ... }
   * @param {Array}    prieres   celles qui doivent sonner
   */
  function programmer(timesFor, prieres, jours, audio) {
    if (!dispo) return Promise.reject(new Error("Pont natif absent."));

    const alarms = [];
    const maintenant = Date.now();
    const n = jours || 7;

    for (let d = 0; d < n; d++) {
      const jour = new Date();
      jour.setHours(0, 0, 0, 0);
      jour.setDate(jour.getDate() + d);

      let t;
      try { t = timesFor(jour); }
      catch (e) { continue; }        // un jour illisible n'annule pas les autres

      for (const p of prieres) {
        const quand = t[p];
        // ⚠️ Les nuits d'été de Bruxelles laissent Fajr et Isha indéfinis :
        // c'est un cas NORMAL et documenté, pas une anomalie. On saute.
        if (!quand || isNaN(+quand)) continue;
        if (+quand <= maintenant) continue;
        alarms.push({ at: +quand, prayer: p });
      }
    }

    alarms.sort((a, b) => a.at - b.at);
    // Les réglages audio partent AVEC les alarmes, pas séparément : le
    // service doit pouvoir jouer sans page chargée, et une programmation
    // sans réglages le laisserait muet ou sur le mauvais haut-parleur.
    const a = audio || {};
    return appel("programmer", {
      alarms: alarms,
      sortie: a.sortie || "local",
      hote: a.hote || "",
      plancher: (a.plancher === null || a.plancher === undefined) ? -1 : a.plancher
    })
      .then(r => Object.assign({ envoyees: alarms.length }, r || {}));
  }

  function ecouter(quoi, fn) {
    if (!P || typeof P.addListener !== "function") return;
    try { P.addListener(quoi, fn); } catch (e) { /* sans conséquence */ }
  }

  root.AdhanNative = {
    dispo: function () { return dispo; },
    programmer: programmer,
    jouer: function (priere) { return appel("jouer", { prayer: priere || "" }); },
    arreter: function () { return appel("arreter"); },
    etat: function () { return appel("etat"); },
    enCours: function () { return appel("enCours"); },
    demarrerVeille: function () { return appel("demarrerVeille"); },
    demanderNotifications: function () { return appel("demanderNotifications"); },
    demanderExemptionBatterie: function () { return appel("demanderExemptionBatterie"); },
    ouvrirReglagesAlarmes: function () { return appel("ouvrirReglagesAlarmes"); },
    chercherBarres: function () { return appel("chercherBarres"); },
    testerBarre: function (hote) { return appel("testerBarre", { hote: hote || "" }); },
    testerReveil: function (min) { return appel("testerReveil", { minutes: min || 2 }); },
    ecouter: ecouter
  };
})(typeof self !== "undefined" ? self : this);
