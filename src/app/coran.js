// =====================================================================
// Coran — écoute des récitateurs (onglet « Coran »).
//
// Source : MP3Quran.net — catalogue de ~242 récitateurs, vérifié : l'API et
// les MP3 autorisent les appels depuis une page web (CORS *), donc TOUT vit
// ici, côté web. Le natif ne sert qu'à envoyer vers la barre de son.
//
// ⭐ ARCHITECTURE, et pourquoi :
//  - RIEN n'est embarqué dans l'APK (un seul récitateur complet pèse ~1 Go).
//    On streame, et on garde en cache ce qui a été écouté (Cache API) pour
//    le réécouter sans réseau.
//  - L'ADHAN NE DÉPEND JAMAIS DE CE FICHIER. Le réveil reste embarqué et
//    hors ligne ; si MP3Quran tombe, seule l'écoute du Coran s'arrête.
//  - Le catalogue est gardé 7 jours en localStorage : l'onglet s'ouvre
//    instantanément, et fonctionne hors ligne avec le dernier catalogue vu.
// =====================================================================

(function (root) {
  "use strict";

  // ---------- Les 114 sourates : numéro, nom courant, nom arabe ----------
  // Embarquées : ~4 Ko, et l'onglet ne dépend d'aucun réseau pour s'afficher.
  var SOURATES = [
    ["Al-Fatiha","الفاتحة"],["Al-Baqara","البقرة"],["Al-Imran","آل عمران"],
    ["An-Nisa","النساء"],["Al-Ma'ida","المائدة"],["Al-An'am","الأنعام"],
    ["Al-A'raf","الأعراف"],["Al-Anfal","الأنفال"],["At-Tawba","التوبة"],
    ["Yunus","يونس"],["Hud","هود"],["Yusuf","يوسف"],["Ar-Ra'd","الرعد"],
    ["Ibrahim","إبراهيم"],["Al-Hijr","الحجر"],["An-Nahl","النحل"],
    ["Al-Isra","الإسراء"],["Al-Kahf","الكهف"],["Maryam","مريم"],["Ta-Ha","طه"],
    ["Al-Anbiya","الأنبياء"],["Al-Hajj","الحج"],["Al-Mu'minun","المؤمنون"],
    ["An-Nur","النور"],["Al-Furqan","الفرقان"],["Ash-Shu'ara","الشعراء"],
    ["An-Naml","النمل"],["Al-Qasas","القصص"],["Al-Ankabut","العنكبوت"],
    ["Ar-Rum","الروم"],["Luqman","لقمان"],["As-Sajda","السجدة"],
    ["Al-Ahzab","الأحزاب"],["Saba","سبأ"],["Fatir","فاطر"],["Ya-Sin","يس"],
    ["As-Saffat","الصافات"],["Sad","ص"],["Az-Zumar","الزمر"],["Ghafir","غافر"],
    ["Fussilat","فصلت"],["Ash-Shura","الشورى"],["Az-Zukhruf","الزخرف"],
    ["Ad-Dukhan","الدخان"],["Al-Jathiya","الجاثية"],["Al-Ahqaf","الأحقاف"],
    ["Muhammad","محمد"],["Al-Fath","الفتح"],["Al-Hujurat","الحجرات"],
    ["Qaf","ق"],["Adh-Dhariyat","الذاريات"],["At-Tur","الطور"],
    ["An-Najm","النجم"],["Al-Qamar","القمر"],["Ar-Rahman","الرحمن"],
    ["Al-Waqi'a","الواقعة"],["Al-Hadid","الحديد"],["Al-Mujadila","المجادلة"],
    ["Al-Hashr","الحشر"],["Al-Mumtahana","الممتحنة"],["As-Saff","الصف"],
    ["Al-Jumu'a","الجمعة"],["Al-Munafiqun","المنافقون"],["At-Taghabun","التغابن"],
    ["At-Talaq","الطلاق"],["At-Tahrim","التحريم"],["Al-Mulk","الملك"],
    ["Al-Qalam","القلم"],["Al-Haqqa","الحاقة"],["Al-Ma'arij","المعارج"],
    ["Nuh","نوح"],["Al-Jinn","الجن"],["Al-Muzzammil","المزمل"],
    ["Al-Muddaththir","المدثر"],["Al-Qiyama","القيامة"],["Al-Insan","الإنسان"],
    ["Al-Mursalat","المرسلات"],["An-Naba","النبأ"],["An-Nazi'at","النازعات"],
    ["Abasa","عبس"],["At-Takwir","التكوير"],["Al-Infitar","الانفطار"],
    ["Al-Mutaffifin","المطففين"],["Al-Inshiqaq","الانشقاق"],["Al-Buruj","البروج"],
    ["At-Tariq","الطارق"],["Al-A'la","الأعلى"],["Al-Ghashiya","الغاشية"],
    ["Al-Fajr","الفجر"],["Al-Balad","البلد"],["Ash-Shams","الشمس"],
    ["Al-Layl","الليل"],["Ad-Duha","الضحى"],["Ash-Sharh","الشرح"],
    ["At-Tin","التين"],["Al-Alaq","العلق"],["Al-Qadr","القدر"],
    ["Al-Bayyina","البينة"],["Az-Zalzala","الزلزلة"],["Al-Adiyat","العاديات"],
    ["Al-Qari'a","القارعة"],["At-Takathur","التكاثر"],["Al-Asr","العصر"],
    ["Al-Humaza","الهمزة"],["Al-Fil","الفيل"],["Quraysh","قريش"],
    ["Al-Ma'un","الماعون"],["Al-Kawthar","الكوثر"],["Al-Kafirun","الكافرون"],
    ["An-Nasr","النصر"],["Al-Masad","المسد"],["Al-Ikhlas","الإخلاص"],
    ["Al-Falaq","الفلق"],["An-Nas","الناس"]
  ];

  var API = "https://www.mp3quran.net/api/v3/reciters?language=eng";
  var CLE_CATALOGUE = "adhan.coran.catalogue.v1";
  var CLE_CHOIX = "adhan.coran.choix.v1";
  var CLE_POSITION = "adhan.coran.position.v1";
  var CACHE_AUDIO = "coran-audio-v1";
  var CLE_TEXTES = "adhan.coran.texte.v1";
  var CLE_VOLUME = "adhan.coran.volume.v1";
  var QC_API = "https://api.quran.com/api/v4";
  var QC_AUDIO = "https://verses.quran.com/";

  // Correspondance MP3Quran -> récitation Quran.com (fichiers PAR VERSET,
  // donc suivi du texte exact par construction). ⚠️ L'ORDRE COMPTE : les
  // codes mujawwad doivent précéder leur préfixe murattal, sinon
  // « basit_mjwd » matcherait « basit » et jouerait le MAUVAIS enregistrement.
  // Récitateurs absents de la liste : texte affiché SANS suivi — honnête,
  // plutôt qu'un surlignage faux.
  var QC_MAP = [
    ["/basit_mjwd/", 1], ["/basit/", 2],
    ["/minsh_mjwd/", 8], ["/minsh/", 9],
    ["/afs/", 7], ["/sds/", 3], ["/husr/", 6],
    ["/shur/", 10], ["/tblawi/", 11], ["/shatri/", 4], ["/hani/", 5]
  ];
  function recitationQC() {
    for (var i = 0; i < QC_MAP.length; i++) {
      if (etat.choix.serveur.indexOf(QC_MAP[i][0]) !== -1) return QC_MAP[i][1];
    }
    return null;
  }
  var SEPT_JOURS = 7 * 24 * 3600 * 1000;

  // Récitateur par défaut, VÉRIFIÉ à la main (serveur testé en 200) : l'onglet
  // marche dès la première ouverture, même sans catalogue.
  var DEFAUT = {
    recitateur: "Mishary Alafasi",
    moshaf: "Rewayat Hafs A'n Assem - Murattal",
    serveur: "https://server8.mp3quran.net/afs/",
    liste: null            // null = les 114
  };

  var etat = {
    choix: null,           // { recitateur, moshaf, serveur, liste }
    catalogue: null,       // [ { n, m: [ { nom, srv, liste } ] } ]
    enCache: {},           // url -> true (badges « téléchargée »)
    enLecture: null,       // numéro de sourate en cours, ou null
    surBarre: false,
    blobUrl: null,         // à révoquer avant d'en créer un autre
    seq: 0,                // jeton de génération : deux touchers rapides, seul le dernier gagne
    dlCtrl: null,          // téléchargement d'arrière-plan en cours, pour l'annuler
    texte: false,          // mode « Suivre le texte » (verset par verset)
    versets: null,         // [{ key, txt }] de la sourate affichée
    versetIdx: -1,         // verset en cours (mode texte)
    versetUrls: null,      // audio par verset (Quran.com), si récitateur couvert
    volume: 1              // volume local de la tablette, persisté
  };

  function $(id) { return document.getElementById(id); }
  // Les <li> cliquables doivent aussi repondre au clavier/D-pad : focusables,
  // et Entree/Espace vaut un toucher.
  function cliquable(li) {
    li.tabIndex = 0;
    li.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); li.click(); }
    });
  }
  function lireJson(cle) { try { return JSON.parse(localStorage.getItem(cle)); } catch (e) { return null; } }
  function ecrireJson(cle, v) { try { localStorage.setItem(cle, JSON.stringify(v)); } catch (e) {} }
  var natif = function () { return !!(root.AdhanNative && root.AdhanNative.dispo()); };

  // ---------- Adresses -----------------------------------------------------
  function urlSourate(n) {
    var num = String(n);
    while (num.length < 3) num = "0" + num;
    return etat.choix.serveur + num + ".mp3";
  }
  function souratesDisponibles() {
    if (!etat.choix.liste) return null;                 // toutes
    var ok = {};
    etat.choix.liste.split(",").forEach(function (x) { ok[Number(x)] = true; });
    return ok;
  }

  // ---------- Catalogue ----------------------------------------------------
  function chargerCatalogue(force) {
    var garde = lireJson(CLE_CATALOGUE);
    if (garde && garde.quand && Date.now() - garde.quand < SEPT_JOURS && !force) {
      etat.catalogue = garde.liste;
      return Promise.resolve(true);
    }
    if (typeof fetch !== "function") return Promise.resolve(false);
    // Délai borné (le garde-fou qu'a déjà loadSettings) : un réseau qui
    // pend laissait « Chargement du catalogue… » à l'infini.
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    if (ctrl) setTimeout(function () { ctrl.abort(); }, 10000);
    return fetch(API, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        // On ne garde que l'utile : le catalogue complet pèserait cher en
        // localStorage pour rien.
        etat.catalogue = (j.reciters || []).map(function (r) {
          return { n: r.name, m: (r.moshaf || []).map(function (m) {
            return { nom: m.name, srv: m.server, liste: m.surah_list };
          }) };
        });
        ecrireJson(CLE_CATALOGUE, { quand: Date.now(), liste: etat.catalogue });
        return true;
      })
      .catch(function (e) {
        // Pas de réseau : le vieux catalogue vaut mieux que rien du tout.
        if (garde && garde.liste) { etat.catalogue = garde.liste; return true; }
        console.log("Catalogue Coran indisponible : " + e.message);
        return false;
      });
  }

  // ---------- Texte arabe (Uthmani) + audio par verset ----------------------
  // Le garde-fou du catalogue, factorisé : un réseau qui pend ne doit
  // jamais laisser un écran attendre à l'infini.
  function fetchBorne(url) {
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    if (ctrl) setTimeout(function () { ctrl.abort(); }, 10000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
  }

  function chargerTexte(n) {
    var stock = lireJson(CLE_TEXTES) || { ordre: [], par: {} };
    if (stock.par[n]) {
      // Vrai LRU : le hit remonte la sourate en tête, sinon les plus
      // écoutées seraient évincées les premières (FIFO déguisé).
      stock.ordre = stock.ordre.filter(function (x) { return String(x) !== String(n); });
      stock.ordre.push(n);
      ecrireJson(CLE_TEXTES, stock);
      return Promise.resolve(stock.par[n]);
    }
    return fetchBorne(QC_API + "/quran/verses/uthmani?chapter_number=" + n)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        var v = (j.verses || []).map(function (x) {
          return { key: x.verse_key, txt: x.text_uthmani };
        });
        if (!v.length) throw new Error("sourate vide");
        // Cache LRU : 12 sourates maximum — tout le Coran en localStorage
        // pèserait ~1 Mo pour rien.
        stock.par[n] = v;
        stock.ordre = stock.ordre.filter(function (x) { return x !== n; });
        stock.ordre.push(n);
        while (stock.ordre.length > 12) delete stock.par[stock.ordre.shift()];
        ecrireJson(CLE_TEXTES, stock);
        return v;
      });
  }

  function chargerVersetsAudio(n, rec) {
    return fetchBorne(QC_API + "/recitations/" + rec + "/by_chapter/" + n)
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (j) {
        var l = (j.audio_files || []).map(function (a) { return QC_AUDIO + a.url; });
        if (!l.length) throw new Error("aucun audio par verset");
        return l;
      });
  }

  // ---------- Cache audio (réécoute hors ligne) ----------------------------
  function ouvrirCache() {
    if (!root.caches) return Promise.resolve(null);
    return caches.open(CACHE_AUDIO).catch(function () { return null; });
  }
  function relireBadges() {
    return ouvrirCache().then(function (c) {
      if (!c) return;
      return c.keys().then(function (reqs) {
        etat.enCache = {};
        reqs.forEach(function (q) { etat.enCache[q.url] = true; });
      });
    });
  }
  function cacherEnArrierePlan(url) {
    if (!root.caches || etat.enCache[url]) return;
    // Un seul téléchargement d'arrière-plan à la fois : enchaîner les
    // sourates empilait des copies intégrales concurrentes du flux d'écoute.
    if (etat.dlCtrl) { try { etat.dlCtrl.abort(); } catch (e) {} }
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    etat.dlCtrl = ctrl;
    ouvrirCache().then(function (c) {
      if (!c) return;
      // fetch séparé du flux de lecture : le <audio> lit en continu pendant
      // que cette copie intégrale se range pour les prochaines fois.
      fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return c.put(url, r);
      }).then(function () {
        etat.enCache[url] = true;
        majBadge(url);
      }).catch(function (e) { console.log("Cache Coran : " + e.message); });
    });
  }

  // ---------- Lecture ------------------------------------------------------
  function jouer(n) {
    var url = urlSourate(n);
    var audio = $("coran-audio");
    etat.enLecture = n;
    etat.surBarre = false;
    // Course : toucher la sourate 2 puis vite la 3 lançait deux chaînes
    // asynchrones ; si la plus lente finissait dernière, elle écrasait la
    // lecture ET révoquait le blob de la gagnante. Le jeton tranche.
    var jeton = ++etat.seq;

    var demarrer = function (src) {
      if (jeton !== etat.seq) return;   // un toucher plus récent a gagné
      audio.volume = etat.volume;
      if (etat.blobUrl) { try { URL.revokeObjectURL(etat.blobUrl); } catch (e) {} etat.blobUrl = null; }
      audio.src = src;
      // Reprise : si on rouvre LA sourate interrompue, on repart où on était.
      var pos = lireJson(CLE_POSITION);
      if (pos && pos.url === url && typeof pos.sec === "number" && pos.sec > 10) {
        audio.currentTime = pos.sec;
      }
      var p = audio.play();
      if (p && p.catch) p.catch(function (e) {
        console.log("Lecture : " + e.message);
        majTitre("Lecture impossible — réessaie, ou vérifie la connexion.");
      });
    };

    // Mode « Suivre le texte » : la lecture passe verset par verset.
    // ⚠️ Couper l'audio en cours AVANT le fetch : un verset de l'ANCIENNE
    // sourate qui se terminait pendant le chargement déclenchait « ended »
    // avec l'ancienne liste — mauvaise sourate jouée, voire saut à la
    // suivante qui annulait le chargement demandé.
    if (etat.texte) {
      try { audio.pause(); } catch (e) {}
      etat.versetUrls = null;
      etat.versetIdx = -1;
      // C9 — état de chargement : montrer « Chargement du texte… » plutôt
      // que l'ancien texte sous le nouveau titre.
      etat.versets = null;
      renderTexte(n);
      jouerEnModeTexte(n, jeton);
      majListe();
      majLecteur();
      return;
    }

    // En cache -> hors ligne ; sinon flux direct + copie en arrière-plan.
    ouvrirCache().then(function (c) {
      if (c) {
        return c.match(url).then(function (rep) {
          if (rep) return rep.blob().then(function (b) {
            etat.blobUrl = URL.createObjectURL(b);
            demarrer(etat.blobUrl);
          });
          demarrer(url);
          cacherEnArrierePlan(url);
        });
      }
      demarrer(url);
    });

    majListe();
    majLecteur();
  }

  // ---------- Lecture verset par verset (mode texte) ------------------------
  function jouerEnModeTexte(n, jeton) {
    // Libérer le blob du mode continu : une longue sourate en cache, ce
    // sont des dizaines de Mo retenus pendant toute la session texte.
    if (etat.blobUrl) { try { URL.revokeObjectURL(etat.blobUrl); } catch (e) {} etat.blobUrl = null; }
    var rec = recitationQC();
    Promise.all([
      chargerTexte(n),
      // L'audio par verset qui échoue ne doit pas emporter le TEXTE avec
      // lui : hors ligne, le texte en cache reste lisible et la récitation
      // bascule en continu (elle, possiblement en cache aussi).
      rec ? chargerVersetsAudio(n, rec).catch(function () { return null; })
          : Promise.resolve(null)
    ]).then(function (res) {
      if (jeton !== etat.seq) return;
      etat.versets = res[0];
      etat.versetUrls = res[1];
      renderTexte(n);
      if (etat.versetUrls) {
        jouerVerset(0, jeton);
      } else {
        // Récitateur non couvert par Quran.com : le texte s'affiche, l'audio
        // reste le fichier complet MP3Quran — sans surlignage, et on le DIT.
        majNoteTexte("Texte affiché — le suivi verset par verset n'existe pas "
          + "pour ce récitateur. Récitation en continu.");
        // Repli continu par le CACHE, comme le mode normal : hors ligne,
        // une sourate téléchargée doit rester écoutable ici aussi.
        var audio = $("coran-audio");
        audio.volume = etat.volume;
        var url = urlSourate(n);
        ouvrirCache().then(function (c) {
          return c ? c.match(url) : null;
        }).then(function (rep) {
          if (jeton !== etat.seq) return;
          if (rep) return rep.blob().then(function (b) {
            if (jeton !== etat.seq) return;
            if (etat.blobUrl) { try { URL.revokeObjectURL(etat.blobUrl); } catch (e) {} }
            etat.blobUrl = URL.createObjectURL(b);
            audio.src = etat.blobUrl;
            var p = audio.play(); if (p && p.catch) p.catch(function () {});
          });
          audio.src = url;
          var p = audio.play(); if (p && p.catch) p.catch(function () {});
          cacherEnArrierePlan(url);
        });
      }
      majLecteur();
    }).catch(function (e) {
      if (jeton !== etat.seq) return;
      // Purger l'ANCIEN état : sans ça, le titre affichait la nouvelle
      // sourate au-dessus du texte de l'ancienne, versets cliquables inclus.
      etat.versets = null;
      etat.versetUrls = null;
      etat.versetIdx = -1;
      renderTexte(n);
      console.log("Texte Coran : " + e.message);
      majNoteTexte("Texte indisponible — vérifier la connexion, puis réessayer.");
    });
  }

  function jouerVerset(i, jeton) {
    if (jeton !== etat.seq) return;
    if (!etat.versetUrls) return;
    if (i < 0) i = 0;
    if (i >= etat.versetUrls.length) { finDeSourate(); return; }
    etat.versetIdx = i;
    var audio = $("coran-audio");
    audio.volume = etat.volume;
    var url = etat.versetUrls[i];
    // Cache d'abord : la tablette murale réécoute les mêmes sourates chaque
    // jour — sans cache, chaque écoute re-téléchargeait chaque verset.
    // Cache SÉPARÉ (coran-versets-v1) : les badges de la liste itèrent les
    // clés du cache des sourates complètes, il ne faut pas les polluer.
    ouvrirCacheVersets().then(function (c) {
      return c ? c.match(url) : null;
    }).then(function (rep) {
      if (jeton !== etat.seq || etat.versetIdx !== i) return;
      if (rep) return rep.blob().then(function (b) {
        if (jeton !== etat.seq || etat.versetIdx !== i) return;
        if (etat.blobUrl) { try { URL.revokeObjectURL(etat.blobUrl); } catch (e) {} }
        etat.blobUrl = URL.createObjectURL(b);
        audio.src = etat.blobUrl;
        var p = audio.play(); if (p && p.catch) p.catch(function () {});
      });
      audio.src = url;
      var p = audio.play(); if (p && p.catch) p.catch(function () {});
      // Copie en arrière-plan pour la prochaine fois (petit fichier).
      ouvrirCacheVersets().then(function (c2) {
        if (!c2) return;
        fetchBorne(url).then(function (r) {
          if (r.ok) return c2.put(url, r);
        }).catch(function () {});
      });
    });
    surlignerVerset(i);
    ecrireJson(CLE_POSITION, { url: urlSourate(etat.enLecture), verset: i });
  }

  function ouvrirCacheVersets() {
    if (!root.caches) return Promise.resolve(null);
    return caches.open("coran-versets-v1").catch(function () { return null; });
  }

  function finDeSourate() {
    // Même règle qu'en mode continu : on enchaîne sur la sourate suivante.
    var dispo = souratesDisponibles();
    var n = etat.enLecture;
    for (var s = n + 1; s <= 114; s++) {
      if (!dispo || dispo[s]) { jouer(s); return; }
    }
    arreter();
  }

  function surlignerVerset(i) {
    var corps = $("coran-texte-corps");
    if (!corps) return;
    var actifs = corps.querySelectorAll(".verset.actif");
    for (var a = 0; a < actifs.length; a++) actifs[a].classList.remove("actif");
    var el2 = corps.querySelector('.verset[data-i="' + i + '"]');
    if (el2) {
      el2.classList.add("actif");
      // Défilement doux vers le verset — sauf si l'utilisateur a demandé
      // moins de mouvement.
      var doux = !(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches);
      try { el2.scrollIntoView({ block: "center", behavior: doux ? "smooth" : "auto" }); } catch (e) {}
    }
  }

  function majNoteTexte(txt) {
    var n2 = $("coran-texte-note");
    if (n2) n2.textContent = txt || "";
  }

  function renderTexte(n) {
    var corps = $("coran-texte-corps");
    var nom = $("coran-texte-nom");
    if (!corps) return;
    if (nom) nom.textContent = n + ". " + SOURATES[n - 1][0] + " · " + SOURATES[n - 1][1];
    majNoteTexte(etat.versetUrls ? "Touche un verset pour l'écouter." : "");
    corps.textContent = "";
    if (!etat.versets) {
      var att = document.createElement("span");
      att.className = "vide";
      att.textContent = "Chargement du texte…";
      corps.appendChild(att);
      return;
    }
    etat.versets.forEach(function (v, i) {
      var sp = document.createElement("span");
      sp.className = "verset";
      sp.dataset.i = String(i);
      sp.appendChild(document.createTextNode(v.txt));
      var num = document.createElement("span");
      num.className = "verset-num";
      num.textContent = v.key.split(":")[1];
      sp.appendChild(num);
      sp.addEventListener("click", function () {
        // Toucher un verset = y aller — seulement si l'audio par verset existe.
        if (etat.texte && etat.versetUrls) jouerVerset(i, etat.seq);
      });
      corps.appendChild(sp);
      corps.appendChild(document.createTextNode(" "));
    });
  }

  function basculerTexte() {
    if (etat.enLecture == null) return;
    if (etat.surBarre) {
      majTitre("Le suivi du texte se fait sur la tablette — reviens d'abord de la barre.");
      return;
    }
    etat.texte = !etat.texte;
    var panneau = $("coran-texte");
    if (etat.texte) {
      panneau.classList.remove("hidden");
      jouer(etat.enLecture);        // repart en mode verset (ou continu + texte)
    } else {
      panneau.classList.add("hidden");
      etat.versetIdx = -1;
      etat.versetUrls = null;
      jouer(etat.enLecture);        // reprend le fichier complet MP3Quran
    }
    majLecteur();
  }

  function pauseOuReprise() {
    var audio = $("coran-audio");
    if (audio.paused) { var p = audio.play(); if (p && p.catch) p.catch(function () {}); }
    else audio.pause();
  }

  function arreter() {
    // ⚠️ Invalider le jeton EN PREMIER : sans ça, un fetch encore en vol
    // (texte ou cache) redémarrait l'audio APRÈS l'arrêt — lecture fantôme,
    // lecteur caché, impossible à stopper sans recharger.
    etat.seq++;
    arreterSuiviBarre();
    var audio = $("coran-audio");
    try { audio.pause(); audio.currentTime = 0; } catch (e) {}
    audio.removeAttribute("src"); audio.load();
    // Libérer le blob (une longue sourate = des dizaines de Mo retenus) et
    // couper le téléchargement d'arrière-plan devenu inutile.
    if (etat.blobUrl) { try { URL.revokeObjectURL(etat.blobUrl); } catch (e) {} etat.blobUrl = null; }
    if (etat.dlCtrl) { try { etat.dlCtrl.abort(); } catch (e) {} etat.dlCtrl = null; }
    if (etat.surBarre && natif()) root.AdhanNative.coranCastArreter().catch(function () {});
    etat.enLecture = null;
    etat.surBarre = false;
    etat.texte = false;
    etat.versetIdx = -1;
    etat.versetUrls = null;
    var panneau = $("coran-texte");
    if (panneau) panneau.classList.add("hidden");
    var bt = $("coran-texte-btn");
    if (bt) bt.classList.remove("actif");
    ecrireJson(CLE_POSITION, null);
    majListe();
    majLecteur();
  }

  // ---------- Barre de son -------------------------------------------------
  // Quand la barre joue, la tablette n'a AUCUNE horloge locale : sans ce
  // suivi, le temps restait figé (constat terrain : bloqué à 0:02 pendant
  // que la récitation continuait).
  var suiviBarre = null;
  function demarrerSuiviBarre() {
    arreterSuiviBarre();
    if (!natif()) return;
    suiviBarre = setInterval(function () {
      if (!etat.surBarre) { arreterSuiviBarre(); return; }
      root.AdhanNative.coranCastEtat().then(function (r) {
        if (!etat.surBarre) return;
        if (!r || !r.actif) {
          // La barre a fini (ou la session est morte) : on referme le
          // lecteur proprement au lieu de rester « Sur la barre » à vie.
          arreter();
          return;
        }
        var tEl = $("coran-temps");
        if (tEl && typeof r.position === "number") {
          tEl.textContent = fmt(r.position) + " / " + fmt(r.duree || NaN);
        }
        var seek = $("coran-seek");
        if (seek && r.duree > 0) {
          seek.value = String(Math.round(r.position * 1000 / r.duree));
        }
      }).catch(function () {});
    }, 2000);
  }
  function arreterSuiviBarre() {
    if (suiviBarre) { clearInterval(suiviBarre); suiviBarre = null; }
  }
  function versLaBarre() {
    if (!natif()) { majTitre("La barre n'est joignable que depuis l'application Android."); return; }
    if (etat.enLecture == null) return;
    // Invalider les chaînes en vol : sans ça, un fetch de mode texte qui se
    // terminait APRÈS l'envoi relançait l'audio local PAR-DESSUS la barre.
    etat.seq++;
    // La barre lit le fichier complet MP3Quran : on quitte le mode texte.
    if (etat.texte) {
      etat.texte = false;
      etat.versetIdx = -1; etat.versetUrls = null;
      var panneau = $("coran-texte");
      if (panneau) panneau.classList.add("hidden");
    }
    var n = etat.enLecture;
    var audio = $("coran-audio");
    audio.pause();
    etat.surBarre = true;
    majLecteur();
    majTitre("Envoi vers la barre…");
    // La barre streame TOUTE SEULE depuis MP3Quran : la tablette ne relaie
    // rien, on lui donne juste l'adresse et le titre.
    root.AdhanNative.coranCast(urlSourate(n), "Coran — " + SOURATES[n - 1][0])
      .then(function (r) {
        if (r && r.ok) {
          majTitre("Sur la barre : " + SOURATES[n - 1][0]);
          if (root.toast) root.toast("Envoyé à la barre de son");
          demarrerSuiviBarre();
        }
        else {
          etat.surBarre = false;
          majTitre("La barre n'a pas répondu" + (r && r.raison ? " — " + r.raison : "") +
                   ". Vérifie son adresse dans Réglages.");
          majLecteur();
        }
      })
      .catch(function (e) {
        etat.surBarre = false;
        console.log("Envoi barre : " + e.message);
        majTitre("Envoi impossible — vérifie que la barre est allumée et sur le même Wi-Fi.");
        majLecteur();
      });
  }

  // ---------- Interface ----------------------------------------------------
  function fmt(sec) {
    if (!isFinite(sec)) return "--:--";
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function majTitre(txt) {
    var t = $("coran-titre");
    if (t) t.textContent = txt;
  }
  function majBadge(url) {
    document.querySelectorAll("#coran-liste li").forEach(function (li) {
      if (li.dataset.url === url) li.classList.add("telechargee");
    });
    // Confirmation transitoire : le telechargement s est fini tout seul, en
    // arriere-plan — sans toast, personne ne saurait jamais qu il a abouti.
    var m = url.match(/(\d{3})\.mp3$/);
    var n = m ? Number(m[1]) : 0;
    if (n >= 1 && n <= 114 && root.toast) {
      root.toast(SOURATES[n - 1][0] + " est disponible hors ligne");
    }
  }

  function majLecteur() {
    var bar = $("coran-player");
    if (!bar) return;
    bar.classList.toggle("hidden", etat.enLecture == null);
    // Le lecteur persiste sur tous les onglets : chaque vue réserve la place
    // en bas, sinon les boutons de fin de page restent enterrés sous lui.
    var app = document.getElementById("app");
    if (app) app.classList.toggle("avec-lecteur", etat.enLecture != null);
    if (etat.enLecture == null) return;

    var s = SOURATES[etat.enLecture - 1];
    if (!etat.surBarre) majTitre(s[0] + " · " + s[1]);

    var audio = $("coran-audio");
    $("coran-play").textContent = (etat.surBarre || audio.paused) ? "▶" : "⏸";
    $("coran-play").disabled = etat.surBarre;
    $("coran-seek").disabled = etat.surBarre || etat.texte;
    $("coran-barre-btn").classList.toggle("actif", etat.surBarre);
    $("coran-rew").disabled = etat.surBarre;
    $("coran-fwd").disabled = etat.surBarre;
    // En mode texte, ±10 s devient verset précédent/suivant : l'étiquette
    // DOIT suivre, sinon le bouton ment.
    var vers = !!(etat.texte && etat.versetUrls);
    $("coran-rew").textContent = vers ? "‹ Verset" : "−10 s";
    $("coran-fwd").textContent = vers ? "Verset ›" : "+10 s";
    $("coran-rew").setAttribute("aria-label", vers ? "Verset précédent" : "Reculer de 10 secondes");
    $("coran-fwd").setAttribute("aria-label", vers ? "Verset suivant" : "Avancer de 10 secondes");
    var bt = $("coran-texte-btn");
    // PAS de disabled quand la barre joue : un bouton mort n'explique rien.
    // Le clic passe par basculerTexte(), qui affiche pourquoi.
    if (bt) { bt.classList.toggle("actif", etat.texte); }
    var vr = $("coran-vol-row");
    if (vr) {
      vr.classList.remove("hidden");
      var vc = $("coran-vol");
      if (vc) {
        vc.setAttribute("aria-label",
          etat.surBarre ? "Volume de la barre de son" : "Volume de la tablette");
        // En revenant à la tablette, le curseur reprend le réglage local.
        if (!etat.surBarre) vc.value = String(Math.round(etat.volume * 100));
      }
    }
  }

  function majListe() {
    document.querySelectorAll("#coran-liste li").forEach(function (li) {
      li.classList.toggle("en-lecture", Number(li.dataset.n) === etat.enLecture);
    });
  }

  function renderListe() {
    var ul = $("coran-liste");
    if (!ul) return;
    ul.textContent = "";
    var dispo = souratesDisponibles();
    for (var n = 1; n <= 114; n++) {
      if (dispo && !dispo[n]) continue;
      var s = SOURATES[n - 1];
      var url = urlSourate(n);
      var li = document.createElement("li");
      li.dataset.n = String(n);
      li.dataset.url = url;
      li.className = (etat.enCache[url] ? "telechargee " : "") +
                     (n === etat.enLecture ? "en-lecture" : "");
      li.innerHTML = "";
      var num = document.createElement("span"); num.className = "coran-num"; num.textContent = n;
      var tx = document.createElement("div"); tx.className = "coran-noms";
      var a = document.createElement("strong"); a.textContent = s[0];
      var b = document.createElement("span"); b.textContent = s[1];
      tx.appendChild(a); tx.appendChild(b);
      var dl = document.createElement("span"); dl.className = "coran-dl"; dl.textContent = "téléchargée";
      li.appendChild(num); li.appendChild(tx); li.appendChild(dl);
      li.addEventListener("click", (function (num2) {
        return function () { jouer(num2); };
      })(n));
      cliquable(li);
      ul.appendChild(li);
    }
  }

  // ---------- Choix du récitateur ------------------------------------------
  function renderPicker(filtre) {
    var ul = $("coran-recit-liste");
    if (!ul) return;
    ul.textContent = "";
    var f = (filtre || "").toLowerCase();
    var rien = true;
    (etat.catalogue || []).forEach(function (r) {
      if (f && r.n.toLowerCase().indexOf(f) === -1) return;
      r.m.forEach(function (m) {
        rien = false;
        var li = document.createElement("li");
        var a = document.createElement("strong"); a.textContent = r.n;
        var b = document.createElement("span"); b.textContent = m.nom;
        li.appendChild(a); li.appendChild(b);
        if (etat.choix && etat.choix.serveur === m.srv) li.className = "selected";
        cliquable(li);
        li.addEventListener("click", function () {
          etat.choix = { recitateur: r.n, moshaf: m.nom, serveur: m.srv, liste: m.liste || null };
          ecrireJson(CLE_CHOIX, etat.choix);
          $("coran-picker").classList.add("hidden");
          $("coran-recit-nom").textContent = r.n;
          arreter();
          relireBadges().then(renderListe);
        });
        ul.appendChild(li);
      });
    });
    if (rien) {
      var vide = document.createElement("li");
      vide.className = "vide";
      vide.textContent = etat.catalogue
        ? "Aucun récitateur ne correspond."
        : "Catalogue indisponible — vérifier la connexion, puis rouvrir.";
      ul.appendChild(vide);
    }
  }

  // ---------- Démarrage ----------------------------------------------------
  var pretFait = false;
  function preparer() {
    if (pretFait) return;
    pretFait = true;

    etat.choix = lireJson(CLE_CHOIX) || DEFAUT;
    $("coran-recit-nom").textContent = etat.choix.recitateur;

    var audio = $("coran-audio");
    audio.addEventListener("timeupdate", function () {
      if (etat.enLecture == null || etat.surBarre) return;
      $("coran-temps").textContent = fmt(audio.currentTime) + " / " + fmt(audio.duration);
      var seek = $("coran-seek");
      if (!seek.matches(":active") && isFinite(audio.duration) && audio.duration > 0) {
        seek.value = String(Math.round(audio.currentTime * 1000 / audio.duration));
      }
      // Position gardée toutes les ~3 s : la reprise après interruption.
      // JAMAIS en mode texte : la position y est relative au fichier du
      // VERSET — relue par le mode continu, elle sautait à un endroit sans
      // rapport du fichier complet.
      if (!etat.texte && Math.floor(audio.currentTime) % 3 === 0) {
        ecrireJson(CLE_POSITION, { url: urlSourate(etat.enLecture), sec: audio.currentTime });
      }
    });
    audio.addEventListener("play", majLecteur);
    audio.addEventListener("pause", majLecteur);
    audio.addEventListener("ended", function () {
      // Mode texte : le verset suivant, pas la sourate suivante.
      if (etat.texte && etat.versetUrls) {
        jouerVerset(etat.versetIdx + 1, etat.seq);
        return;
      }
      ecrireJson(CLE_POSITION, null);
      // Enchaîner : c'est le mode d'écoute naturel d'une lecture continue.
      var dispo = souratesDisponibles();
      var n = etat.enLecture;
      for (var s = n + 1; s <= 114; s++) {
        if (!dispo || dispo[s]) { jouer(s); return; }
      }
      arreter();
    });
    // Le compteur d'erreurs suit le VERSET (pas l'événement « playing ») :
    // un fichier qui démarre puis casse à mi-flux — panne déterministe —
    // aurait rebouclé à l'infini si « playing » remettait le compteur à zéro.
    var erreursVerset = 0, versetEnErreur = -1;
    audio.addEventListener("error", function () {
      if (etat.enLecture == null || etat.surBarre) return;
      if (etat.texte && etat.versetUrls) {
        if (versetEnErreur !== etat.versetIdx) {
          versetEnErreur = etat.versetIdx;
          erreursVerset = 0;
        }
        erreursVerset++;
        if (erreursVerset <= 1) { jouerVerset(etat.versetIdx, etat.seq); }
        else { jouerVerset(etat.versetIdx + 1, etat.seq); }
        return;
      }
      majTitre("Lecture interrompue — vérifier la connexion.");
    });

    etat.volume = (function () {
      var v = lireJson(CLE_VOLUME);
      return (typeof v === "number" && v >= 0 && v <= 1) ? v : 1;
    })();
    $("coran-vol").value = String(Math.round(etat.volume * 100));
    $("coran-vol").addEventListener("input", function () {
      var v = Number(this.value) / 100;
      if (etat.surBarre) {
        // Geste EXPLICITE : le curseur commande la barre elle-même (constat
        // terrain : « j'ai baissé, la barre n'a pas bougé »). On ne touche
        // pas au réglage local mémorisé — chaque sortie garde le sien.
        if (natif()) root.AdhanNative.coranCastVolume(v).catch(function () {});
        return;
      }
      etat.volume = v;
      audio.volume = etat.volume;
      ecrireJson(CLE_VOLUME, etat.volume);
    });

    // ±10 s en continu ; verset précédent/suivant en mode texte.
    $("coran-rew").addEventListener("click", function () {
      if (etat.texte && etat.versetUrls) { jouerVerset(etat.versetIdx - 1, etat.seq); return; }
      try { audio.currentTime = Math.max(0, audio.currentTime - 10); } catch (e) {}
    });
    $("coran-fwd").addEventListener("click", function () {
      if (etat.texte && etat.versetUrls) { jouerVerset(etat.versetIdx + 1, etat.seq); return; }
      try {
        if (isFinite(audio.duration)) {
          audio.currentTime = Math.min(audio.duration - 0.5, audio.currentTime + 10);
        }
      } catch (e) {}
    });

    $("coran-texte-btn").addEventListener("click", basculerTexte);
    $("coran-texte-fermer").addEventListener("click", function () {
      if (etat.texte) basculerTexte();
      else $("coran-texte").classList.add("hidden");
    });

    $("coran-play").addEventListener("click", pauseOuReprise);
    $("coran-stop").addEventListener("click", arreter);
    $("coran-barre-btn").addEventListener("click", function () {
      if (etat.surBarre) {
        // Revenir sur la tablette : on coupe la barre et on reprend ici.
        if (natif()) root.AdhanNative.coranCastArreter().catch(function () {});
        etat.surBarre = false;
        arreterSuiviBarre();
        majLecteur();
        if (etat.enLecture != null) jouer(etat.enLecture);
      } else {
        versLaBarre();
      }
    });
    $("coran-seek").addEventListener("input", function () {
      var audio2 = $("coran-audio");
      if (isFinite(audio2.duration) && audio2.duration > 0) {
        audio2.currentTime = audio2.duration * Number(this.value) / 1000;
      }
    });

    $("coran-recit-btn").addEventListener("click", function () {
      $("coran-picker").classList.remove("hidden");
      $("coran-recherche").value = "";
      // Premiere ouverture sans cache : dire qu on travaille plutot que de
      // montrer un ecran vide pendant le chargement du catalogue.
      if (!etat.catalogue) {
        var ul = $("coran-recit-liste");
        ul.textContent = "";
        var att = document.createElement("li");
        att.className = "vide";
        att.textContent = "Chargement du catalogue…";
        ul.appendChild(att);
      }
      chargerCatalogue(false).then(function () { renderPicker($("coran-recherche").value); });
      setTimeout(function () { $("coran-recherche").focus(); }, 250);
    });
    $("coran-picker-fermer").addEventListener("click", function () {
      $("coran-picker").classList.add("hidden");
    });
    $("coran-recherche").addEventListener("input", function () {
      renderPicker(this.value);
    });
  }

  root.AdhanCoran = {
    // L'adhan a priorité absolue : l'app appelle ceci avant de sonner —
    // sans quoi récitation et adhan se superposaient, deux voix mêlées au
    // moment le plus solennel. Le lecteur reste en pause : un tap reprend.
    pause: function () {
      // Invalider AUSSI les chaînes en vol : entre deux versets, un fetch
      // qui se résolvait après cette pause relançait la récitation
      // par-dessus l'adhan — la superposition exacte qu'on élimine.
      etat.seq++;
      arreterSuiviBarre();
      var a = $("coran-audio");
      try { if (a && !a.paused) a.pause(); } catch (e) {}
      if (etat.surBarre && natif()) {
        root.AdhanNative.coranCastArreter().catch(function () {});
        etat.surBarre = false;
        majLecteur();
      }
    },
    afficher: function () {
      preparer();
      relireBadges().then(renderListe);
      chargerCatalogue(false);      // en avance, pour un picker instantané
    }
  };
})(typeof self !== "undefined" ? self : this);
