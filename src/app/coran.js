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
    blobUrl: null          // à révoquer avant d'en créer un autre
  };

  function $(id) { return document.getElementById(id); }
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
    return fetch(API)
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
    ouvrirCache().then(function (c) {
      if (!c) return;
      // fetch séparé du flux de lecture : le <audio> lit en continu pendant
      // que cette copie intégrale se range pour les prochaines fois.
      fetch(url).then(function (r) {
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

    var demarrer = function (src) {
      if (etat.blobUrl) { try { URL.revokeObjectURL(etat.blobUrl); } catch (e) {} etat.blobUrl = null; }
      audio.src = src;
      // Reprise : si on rouvre LA sourate interrompue, on repart où on était.
      var pos = lireJson(CLE_POSITION);
      if (pos && pos.url === url && pos.sec > 10) {
        audio.currentTime = pos.sec;
      }
      var p = audio.play();
      if (p && p.catch) p.catch(function (e) {
        majTitre("Lecture impossible : " + e.message);
      });
    };

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

  function pauseOuReprise() {
    var audio = $("coran-audio");
    if (audio.paused) { var p = audio.play(); if (p && p.catch) p.catch(function () {}); }
    else audio.pause();
  }

  function arreter() {
    var audio = $("coran-audio");
    try { audio.pause(); audio.currentTime = 0; } catch (e) {}
    audio.removeAttribute("src"); audio.load();
    if (etat.surBarre && natif()) root.AdhanNative.coranCastArreter().catch(function () {});
    etat.enLecture = null;
    etat.surBarre = false;
    ecrireJson(CLE_POSITION, null);
    majListe();
    majLecteur();
  }

  // ---------- Barre de son -------------------------------------------------
  function versLaBarre() {
    if (!natif()) { majTitre("La barre n'est joignable que depuis l'application Android."); return; }
    if (etat.enLecture == null) return;
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
        if (r && r.ok) majTitre("Sur la barre : " + SOURATES[n - 1][0]);
        else {
          etat.surBarre = false;
          majTitre("La barre n'a pas répondu" + (r && r.raison ? " — " + r.raison : "") +
                   ". Vérifie son adresse dans Réglages.");
          majLecteur();
        }
      })
      .catch(function (e) {
        etat.surBarre = false;
        majTitre("Envoi impossible : " + e.message);
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
  }

  function majLecteur() {
    var bar = $("coran-player");
    if (!bar) return;
    bar.classList.toggle("hidden", etat.enLecture == null);
    if (etat.enLecture == null) return;

    var s = SOURATES[etat.enLecture - 1];
    if (!etat.surBarre) majTitre(s[0] + " · " + s[1]);

    var audio = $("coran-audio");
    $("coran-play").textContent = (etat.surBarre || audio.paused) ? "▶" : "⏸";
    $("coran-play").disabled = etat.surBarre;
    $("coran-seek").disabled = etat.surBarre;
    $("coran-barre-btn").classList.toggle("actif", etat.surBarre);
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
      var dl = document.createElement("span"); dl.className = "coran-dl"; dl.textContent = "hors ligne";
      li.appendChild(num); li.appendChild(tx); li.appendChild(dl);
      li.addEventListener("click", (function (num2) {
        return function () { jouer(num2); };
      })(n));
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
      if (Math.floor(audio.currentTime) % 3 === 0) {
        ecrireJson(CLE_POSITION, { url: urlSourate(etat.enLecture), sec: audio.currentTime });
      }
    });
    audio.addEventListener("play", majLecteur);
    audio.addEventListener("pause", majLecteur);
    audio.addEventListener("ended", function () {
      ecrireJson(CLE_POSITION, null);
      // Enchaîner : c'est le mode d'écoute naturel d'une lecture continue.
      var dispo = souratesDisponibles();
      var n = etat.enLecture;
      for (var s = n + 1; s <= 114; s++) {
        if (!dispo || dispo[s]) { jouer(s); return; }
      }
      arreter();
    });
    audio.addEventListener("error", function () {
      if (etat.enLecture != null && !etat.surBarre) {
        majTitre("Lecture interrompue — vérifier la connexion.");
      }
    });

    $("coran-play").addEventListener("click", pauseOuReprise);
    $("coran-stop").addEventListener("click", arreter);
    $("coran-barre-btn").addEventListener("click", function () {
      if (etat.surBarre) {
        // Revenir sur la tablette : on coupe la barre et on reprend ici.
        if (natif()) root.AdhanNative.coranCastArreter().catch(function () {});
        etat.surBarre = false;
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
      chargerCatalogue(false).then(function () { renderPicker(""); });
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
    afficher: function () {
      preparer();
      relireBadges().then(renderListe);
      chargerCatalogue(false);      // en avance, pour un picker instantané
    }
  };
})(typeof self !== "undefined" ? self : this);
