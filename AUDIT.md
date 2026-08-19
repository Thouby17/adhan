# AUDIT — Adhan TV (phase 1, lecture seule)

**Date de l'audit : 17 août 2026** · Toutes les valeurs ci-dessous ont été
obtenues en **exécutant réellement le code** du projet, pas en le lisant.

---

## ✅ ÉTAT AU 18 AOÛT 2026 — corrections appliquées

Ce rapport décrit le code **tel qu'il était le 17/08**. Les corrections ont été
faites le 18/08 et sont couvertes par `npm test` (17 tests, aucune TV requise).

| # | Problème | État | Preuve |
|---|---|---|---|
| 1 | 🔴 Changement d'heure | **Corrigé** | Dhuhr du 29 mars : **12:48 → 13:48** |
| 2 | 🔴 Règle haute latitude | **Corrigé** | Écart max vs référence : **88 min → 1 min** ; saut du 25/26 mai : **74 min → 0** |
| 3 | 🟠 Isha invisible 77 jours | **Corrigé** | Jours où Isha précède Maghrib : **77 → 0** |
| 4 | 🟠 Prière perdue si gel > 2 min | **Assumé** | Comportement volontaire, verrouillé par un test |
| 5 | 🟠 Doublon au redémarrage | **Corrigé** | Mémoire des déclenchements persistée sur disque |
| 6 | 🟠 Divergence écran / son | **Corrigé** | `config.js` unique ; `npm test` échoue si les copies divergent |
| 7 | 🟡 Cache basculant à 1 h / 2 h | **Corrigé** | Clé de journée en date locale |
| 8 | 🟡 `webOSRelaunch` non géré | **Corrigé** | Gestionnaire ajouté, vérifié dans un navigateur |
| 9 | 🟡 Dashboard figé après alarme | **Corrigé** | Timers relancés avant la tentative de fermeture |
| 10 | 🟡 `lastTriggerKey` unique | **Corrigé** | Remplacé par un planning d'événements identifiés |
| 11 | 🟡 `highLats` non configurable | **Corrigé** | Exposé dans `config.js` |
| 12 | 🟢 Makkah : minutes traitées en angle | **Corrigé** | Champ `ishaMinutes` distinct |

**Et un bug trouvé pendant la correction, absent de ce rapport :** l'équation du
temps sautait de 24 h autour de l'équinoxe de mars (Dhuhr calculé à −11 h au lieu
de 12 h). Il était masqué par un `fixHour` final et n'a été mis à nu qu'en passant
aux instants absolus. Corrigé et verrouillé par un test dédié.

**Réglage retenu :** angles **18° / 18°**, règle `AngleBased`. Décision du
propriétaire, motivée à l'annexe §C-D.

⚠️ **Rien n'a encore été validé sur la vraie TV** — voir §10, les cinq points
non vérifiables hors matériel restent ouverts.

---

## Synthèse en 5 lignes

1. La bibliothèque de calcul **n'est pas** celle de PrayTimes.org : c'est une
   **réécriture maison de 167 lignes** qui s'en inspire. Son cœur est bon (écart
   maximum mesuré **1,05 minute** contre la vraie bibliothèque).
2. 🔴 **Les deux jours de changement d'heure, l'adhan sonne à la mauvaise heure** :
   **1 h trop tôt le 29 mars**, **1 h trop tard le 25 octobre**. Reproduit en simulation.
3. 🔴 **La règle des nuits d'été est mal codée** : elle ne s'applique qu'au tout
   dernier moment au lieu de s'appliquer progressivement. Résultat : **100 jours sur
   365** s'écartent de la référence, jusqu'à **88 minutes**, et le Fajr fait un
   **saut brutal de 74 minutes** entre le 25 et le 26 mai.
4. 🟠 **Du 15 mai au 31 juillet (77 jours), l'écran n'affiche jamais Isha** comme
   prochaine prière — mais **le son, lui, part bien** au bon moment (vérifié).
5. ✅ Calcul **100 % local**, aucun appel réseau. Les deux copies de `praytimes.js`
   sont **rigoureusement identiques** aujourd'hui, et les réglages du service et de
   l'interface **concordent**.

---

## 1. Quelle bibliothèque exactement ?

**Réponse : ce n'est PAS la bibliothèque PrayTimes.org.**

| | Fichier du projet | La vraie bibliothèque |
|---|---|---|
| Nom | `src/app/praytimes.js` et `src/service/praytimes.js` | `PrayTimes.js` |
| Taille | 167 lignes / 6 041 octets | 582 lignes / 15 300 octets |
| Version | **aucune** | ver 2.5 |
| Auteur | **non indiqué** | Hamid Zarrabi-Zadeh |
| Licence | **non indiquée** | GNU LGPL v3.0 |

Ce que dit le fichier lui-même, `src/app/praytimes.js:1-5` :

```js
// PrayTimes - minimal MWL/Egyptian/ISNA prayer time calculator
// Algorithm based on http://praytimes.org/calculation
// Self-contained, no dependencies. ~120 lines.
```

Le mot juste est celui-là : « algorithme inspiré de ». C'est une **réimplémentation
indépendante** de l'algorithme public de Hamid Zarrabi-Zadeh, pas une copie de son
code. Le crédit à praytimes.org est bien présent en ligne 3.

**Vérification par comparaison directe.** J'ai téléchargé la vraie bibliothèque
(`https://praytimes.org/code/v2/js/PrayTimes.js`, v2.5) et je l'ai fait tourner
côte à côte avec celle du projet, sur les 365 jours de 2026 :

| Horaire | Écart maximum sur l'année |
|---|---|
| Lever, Dhuhr, Asr, Maghrib | **1,05 minute** (lever du soleil, le 21 mars) |
| Fajr et Isha en été | **jusqu'à 88 minutes** — voir §7, c'est un vrai défaut |

Autrement dit : **la mécanique solaire est fidèle**, c'est uniquement la règle de
rattrapage des nuits d'été qui est fausse.

Différence technique mineure : la vraie bibliothèque affine son calcul par
itérations successives, celle-ci calcule la position du soleil **une seule fois**,
à midi solaire (`praytimes.js:110`). C'est ce qui explique la minute d'écart.
Sans conséquence pratique pour un adhan.

---

## 2. Paramètres réellement appliqués

### Coordonnées

| Où | Ligne | Valeur |
|---|---|---|
| Interface | `src/app/config.js:8-9` | `latitude: 50.8503` / `longitude: 4.3517` |
| Service | `src/service/adhan_service.js:18-19` | `latitude: 50.8503` / `longitude: 4.3517` |

C'est Bruxelles. Tu m'as parlé de ~50,85 / 4,35 (centre de
Bruxelles) : j'ai mesuré l'écart, il est de **0,2 minute maximum**. Aucune importance.

### Fuseau horaire

**Il n'est écrit nulle part** — il est lu sur l'horloge de la TV au moment du calcul :

- `src/app/praytimes.js:156-158` : `return -new Date().getTimezoneOffset() / 60;`
- `src/service/adhan_service.js:39-41` : même formule.

⚠️ Le point décisif : le décalage est lu **pour l'instant présent**, jamais pour la
date qu'on calcule. C'est la cause directe du bug du changement d'heure (§8, bug n°1).

### Méthode, angles, madhab, haute latitude

| Réglage | Interface | Service | Valeur effective |
|---|---|---|---|
| Méthode | `config.js:12` → `"MWL"` | `adhan_service.js:20` → `"MWL"` | **Muslim World League** |
| Angle Fajr | `praytimes.js:17` | idem (fichier identique) | **18°** |
| Angle Isha | `praytimes.js:17` | idem | **17°** |
| Madhab Asr | `config.js:15` → `"Shafii"`, converti en facteur 1 par `app.js:83` | `adhan_service.js:21` → `asrFactor: 1` | **Shafi'i** (ombre = 1 × objet) |
| Haute latitude | **jamais passé** → valeur par défaut | **jamais passé** → valeur par défaut | **`"AngleBased"`** (`praytimes.js:106`) |
| Ajustement manuel en minutes | — | — | **aucun** — la fonction n'existe pas |

Deux remarques importantes :

- **`highLats` n'est écrit dans aucun fichier de configuration.** Il est décidé par
  la ligne `const highLat = opts.highLat || "AngleBased";` (`praytimes.js:106`). Pour
  le changer aujourd'hui, il faut modifier la bibliothèque elle-même. C'est justement
  le réglage le plus important pour Bruxelles.
- La vraie bibliothèque PrayTimes.org utilise par défaut **une autre règle**
  (`NightMiddle`, milieu de nuit). Le projet a donc fait un choix — mais un choix
  implicite, non documenté, et **mal implémenté** (§7).

---

## 3. Cohérence des deux copies

### Les deux `praytimes.js` : identiques ✅

```
5e73b10424ecde73dde8ce41ac5f3562  src/app/praytimes.js
5e73b10424ecde73dde8ce41ac5f3562  src/service/praytimes.js
```

Empreinte identique, `diff` vide. **Zéro divergence aujourd'hui.**

### Interface et service : mêmes paramètres ✅ … mais rien ne le garantit demain

Tous les réglages concordent aujourd'hui (coordonnées, méthode, madhab,
prières sonores). **Mais les deux fichiers sont indépendants** : `config.js` d'un
côté, un bloc `CONFIG` recopié à la main de l'autre (`adhan_service.js:17-26`).
Le README le dit lui-même : « ⚠️ Garder les deux fichiers en cohérence ! »

**C'est une bombe à retardement, et j'ai mesuré sa puissance.** Si tu changes un
jour `config.js:15` de `"Shafii"` à `"Hanafi"` en oubliant le service :

| Date | Asr affiché à l'écran | Heure à laquelle l'adhan partirait | Décalage |
|---|---|---|---|
| 21 juin | 19:21 | 18:06 | **75 minutes** |
| 21 décembre | 14:53 | 14:23 | **30 minutes** |

L'écran dirait une chose, le son ferait l'autre. **Aucun test, aucun garde-fou ne
détecterait ça** — seulement ta vigilance. C'est le défaut de conception le plus
sérieux du projet après les deux bugs rouges.

À noter aussi : le service expose bien une méthode `getTimes` (`adhan_service.js:101`)
qui permettrait à l'interface de lui demander SES horaires… **mais l'interface ne
l'appelle jamais.** Elle recalcule tout de son côté (`app.js:84`). La solution
existe déjà à moitié dans le code, elle n'est simplement pas branchée.

---

## 4. Horaires réellement calculés

Calculés en exécutant `src/service/praytimes.js` avec les paramètres réels du projet
(50.8503 / 4.3517, MWL, Shafi'i, AngleBased), fuseau Europe/Bruxelles.

| | **21 juin** | **15 mai** | **1er août** | **20 mars** | **21 décembre** |
|---|---|---|---|---|---|
| Fajr | 03:14 | 03:00 | 03:26 | 04:53 | 06:41 |
| Lever | 05:29 | 05:53 | 06:09 | 06:45 | 08:43 |
| Dhuhr | 13:45 | 13:39 | 13:49 | 12:50 | 12:41 |
| Asr | 18:06 | 17:50 | 17:58 | 16:08 | 14:23 |
| Maghrib | 22:00 | 21:25 | 21:29 | 18:55 | 16:39 |
| **Isha** | **00:07** ⚠️ | **00:01** ⚠️ | 23:58 | 20:40 | 18:34 |

⚠️ Le 21 juin et le 15 mai, **Isha tombe après minuit** — donc le lendemain matin.
Le code le stocke quand même dans la journée en cours. Conséquences au §8.

### Les mêmes dates, comparées à la vraie bibliothèque (même règle AngleBased)

| Date | Fajr projet / **référence** | Isha projet / **référence** |
|---|---|---|
| 21 juin | 03:14 / **03:14** ✅ | 00:07 / **00:07** ✅ |
| 15 mai | 03:00 / **03:21** ❌ **−21 min** | 00:01 / **23:49** ❌ **+12 min** |
| 1er août | 03:26 / **03:33** ❌ −7 min | 23:58 / **23:56** ✅ |
| 20 mars | 04:53 / **04:54** ✅ | 20:40 / **20:41** ✅ |
| 21 décembre | 06:41 / **06:40** ✅ | 18:34 / **18:35** ✅ |

Hors été, tout colle à la minute. En été, ça décroche.

---

## 5. Mécanisme de déclenchement — comportement réel

`adhan_service.js` ne programme **aucune alarme** à l'avance. Il regarde l'heure
**toutes les 60 secondes** (`adhan_service.js:131`) et compare à chacune des quatre
prières sonores (`adhan_service.js:65-79`) :

```js
const diffMin = (nowH - times[p]) * 60;
if (diffMin >= 0 && diffMin < 2 && !triggeredToday[p]) { ... launchAdhanApp(p); }
```

Traduit en français : « si l'heure de la prière est passée depuis moins de
2 minutes et que je ne l'ai pas encore jouée aujourd'hui, je lance l'app. »

**J'ai fait tourner le vrai fichier `adhan_service.js`** (avec une fausse horloge et
un faux module webOS) sur chacun de tes cinq scénarios. Voici ce qui se passe :

### a) La TV redémarre / est débranchée puis rallumée

Le service repart à zéro : plus de cache, plus de mémoire de ce qui a déjà sonné.

- **Prière ratée pendant que la TV était éteinte → jamais rattrapée.** Test : service
  démarré le 21/06 à 19:00 (Dhuhr 13:45 et Asr 18:06 déjà passés) → **aucun
  rattrapage**, puis Maghrib 22:01 et Isha 00:08 sonnent normalement.
  👉 C'est le bon comportement (personne ne veut un adhan de 5 h de retard), mais
  ce n'est écrit nulle part — c'est un effet de bord de la fenêtre de 2 minutes.
- 🟠 **En revanche, si le service redémarre DANS la fenêtre de 2 minutes, l'adhan
  est joué DEUX FOIS.** Test : Dhuhr sonne à 13:45:00, service relancé à 13:46:00 →
  **il resonne à 13:46:00**. La mémoire `triggeredToday` (`adhan_service.js:33`)
  ne vit que dans la mémoire vive du processus.

### b) Passage de minuit / recalcul du lendemain

Le cache est reconstruit quand la « clé du jour » change (`adhan_service.js:35-37`) :

```js
function todayKey() { return new Date().toISOString().slice(0, 10); }
```

`toISOString()` renvoie la date **UTC**, pas la date belge. Mesuré :

| Saison | Le cache bascule à… |
|---|---|
| Été (UTC+2) | **02:00** heure locale |
| Hiver (UTC+1) | **01:00** heure locale |

Le calcul, lui, utilise la date **locale** (`praytimes.js:108`). Il y a donc chaque
nuit une fenêtre de 1 à 2 heures où le service travaille sur les horaires de la
veille. **Par chance, c'est exactement ce qu'il faut pour que l'Isha d'été
(00:07) parte au bon moment** — voir §7. Mais c'est un accident heureux, pas une
intention : la marge de sécurité n'est que de **34 minutes**.

### c) Changement d'heure été/hiver — 🔴 **CASSÉ, reproduit**

| | Ce que le service fait | Ce qu'il devrait faire | Écart |
|---|---|---|---|
| **Dim. 29 mars** | Dhuhr lancé à **12:48** | 13:48 | **1 h trop tôt** |
| | Asr 16:17 · Maghrib 19:10 · Isha 20:58 | 17:17 · 20:10 · 21:58 | 1 h trop tôt |
| **Dim. 25 oct.** | Dhuhr lancé à **13:27** | 12:27 | **1 h trop tard** |
| | Asr 16:01 · Maghrib 18:31 · Isha 20:15 | 15:01 · 17:31 · 19:15 | 1 h trop tard |

**Pourquoi.** Le 29 mars, le cache se reconstruit à 01:00 (bascule UTC), donc **avant**
le changement d'heure de 02:00. À cet instant le décalage lu est encore +1 h. Tous
les horaires de la journée sont figés dans l'ancien fuseau, et ne sont **plus jamais
recalculés** jusqu'au lendemain 02:00. Même mécanique à l'envers en octobre.

C'est le bug le plus concret : **deux fois par an, l'adhan sonne à une heure
franchement fausse, toute la journée.**

### d) Dérive d'un timer long — **sans objet** ✅

Il n'y a **aucun `setTimeout` de plusieurs heures** dans le projet. Le service
utilise un `setInterval` de 60 s (`adhan_service.js:131`), l'interface des
intervalles de 1 s et 30 s (`app.js:243-244`). Le seul `setTimeout` long est la
fermeture automatique de l'alarme, 360 s (`app.js:288`). **Rien à craindre de ce
côté-là** — c'est un bon choix d'architecture.

### e) Prière déjà passée au démarrage

Rien ne se déclenche (cf. point a). Comportement correct.

### f) 🟠 Le risque réel : une prière **perdue** silencieusement

La fenêtre de rattrapage n'est que de **2 minutes**. Test : service gelé (mise en
veille) de 13:43 à 13:48 alors que Dhuhr est à 13:45 → **aucun déclenchement,
jamais, aucun message d'erreur**. Sur une TV qui met ses processus en pause, c'est
le scénario le plus probable de « l'adhan n'a pas sonné et on ne sait pas pourquoi ».

Précision du déclenchement, quand tout va bien : **Dhuhr théorique 13:45 → adhan
lancé à 13:45:00**. Entre 0 et 60 s de retard selon le calage du poll — parfait.

### g) 🟡 Deux points à vérifier sur la vraie TV (je ne peux pas trancher ici)

- **Si l'app tourne déjà en arrière-plan**, webOS n'a en principe pas besoin de la
  recharger : il envoie un événement `webOSRelaunch`. Or **`app.js` n'écoute pas cet
  événement** (aucune occurrence dans le fichier). Dans ce cas de figure, l'app
  reviendrait au premier plan sans jouer l'adhan. **Je ne suis pas sûr** du
  comportement exact du firmware LG — à tester sur la TV.
- **Si l'app ne parvient pas à se fermer** après une alarme lancée par le service,
  `closeAlarm` (`app.js:301-307`) sort par un `return` **sans relancer les timers du
  tableau de bord** — l'écran resterait figé, sans horloge ni compte à rebours.

---

## 6. Dépendance réseau

✅ **Aucune. Le calcul est 100 % local.**

Recherche exhaustive de `fetch(`, `XMLHttpRequest`, `http://`, `https://`,
`WebSocket` dans tout `src/` (hors bibliothèque LG `webOSTVjs`) : **zéro appel
réseau**. Les seuls `require` sont `webos-service` (le pont système de LG) et le
fichier `praytimes.js` local.

L'app fonctionne donc sans Internet. Elle dépend uniquement de **l'horloge de la
TV** — qui, elle, se règle par le réseau. Si l'horloge de la TV est fausse, les
horaires seront faux dans la même proportion.

---

## 7. Les nuits d'été à Bruxelles — le point central

### Ce que dit la trigonométrie

J'ai désactivé le repli pour voir la réalité brute. À Bruxelles, avec les angles
MWL (18° / 17°), le soleil ne descend jamais assez bas pendant **52 jours par an,
du 26 mai au 16 juillet**. Sur cette période, Fajr et Isha sont **mathématiquement
impossibles à calculer** : la fonction renvoie `NaN` (`praytimes.js:58`), affiché
`--:--`.

### Ce que fait ce code

Il **n'affiche jamais `NaN`, ni de valeur absurde** — il applique une règle de repli
(`adjustHighLat`, `praytimes.js:84-95`) qui reconstruit Fajr et Isha à partir de la
durée de la nuit. **C'est silencieux : rien à l'écran n'indique que ces deux
horaires ne sont pas des horaires calculés mais des horaires reconstruits.**

### 🔴 Mais la règle est mal codée

Voici la condition qui décide d'appliquer le repli (`praytimes.js:86`) :

```js
if (isNaN(times.fajr) || times.fajr < times.sunrise - night) {
```

Elle compare l'écart à **une nuit entière**. Or la vraie règle compare à la
**portion** de nuit (18/60 ≈ 30 % de la nuit). Le code officiel, lui, dit :

```js
if (isNaN(time) || timeDiff > portion)      // ← portion, pas night
```

Conséquence : la seconde condition **ne se déclenche jamais**. Le repli n'agit
donc **que lorsque la valeur est déjà `NaN`**, au lieu de plafonner progressivement.

**Preuve mesurée — le Fajr saute de 74 minutes en une nuit :**

| Date | Fajr calculé par le projet | Fajr de la référence officielle |
|---|---|---|
| 25 mai | **02:02** | 03:16 |
| 26 mai | **03:16** | 03:16 |

Le 25 mai, le projet annonce Fajr à 02:02 du matin. Le 26, à 03:16. **Une heure et
quart d'écart d'un jour au lendemain**, sans que rien ne le justifie dans le ciel.

**Sur l'année entière : 100 jours sur 365** s'écartent de plus d'une minute de la
référence, avec la même règle. Pires cas : **Fajr le 17 juillet, 01:57 au lieu de
03:25 (−88 min)** ; **Isha le 1er juin, 01:26 au lieu de 00:00 (+86 min)**.

### 🟠 Et Isha passe après minuit — 77 jours par an

Du **15 mai au 31 juillet**, la valeur d'Isha retournée est *plus petite* que celle
de Maghrib (ex. 21 juin : Maghrib 22:00, Isha 00:07). Deux conséquences opposées :

**Pour le son : ça marche.** Vérifié en simulation sur 44 heures :

```
20/06 13:45 → dhuhr     21/06 13:45 → dhuhr
20/06 18:06 → asr       21/06 18:06 → asr
20/06 22:00 → maghrib   21/06 22:01 → maghrib
21/06 00:08 → isha      22/06 00:08 → isha     ← au bon moment
```

Ça fonctionne uniquement parce que le cache ne bascule qu'à 02:00 en été (§5b).
Deux défauts qui s'annulent. **Ça tient à 34 minutes près.**

**Pour l'écran : c'est faux.** La recherche de la prochaine prière (`app.js:124-132`)
prend la première dont l'heure est supérieure à maintenant. Avec Isha à 0,12 h, elle
est sautée. Simulation du 21 juin :

| Heure | Prochaine prière affichée |
|---|---|
| 19:00 | Maghrib |
| 21:54 | Maghrib |
| **22:12** | **Fajr (demain)** ← Isha escamotée |
| 23:00 | Fajr (demain) |
| 00:03 | Fajr |

Et la carte Isha est marquée « passée » (`app.js:142`) toute la journée. Pendant
**77 jours par an**, l'écran ignore Isha — puis l'adhan part quand même à 00:08.
Déroutant.

---

## 8. Problèmes classés par gravité

### 🔴 Critique

| # | Problème | Où | Preuve |
|---|---|---|---|
| 1 | **Changement d'heure : adhan 1 h trop tôt le 29 mars, 1 h trop tard le 25 octobre**, toute la journée. Le fuseau est figé au moment du cache (01:00–02:00) et jamais réévalué. | `adhan_service.js:39-57`, `praytimes.js:156` | Simulation du vrai service : Dhuhr lancé à 12:48 au lieu de 13:48 |
| 2 | **Règle haute latitude mal implémentée** : la condition compare à une nuit entière au lieu d'une portion. Le repli n'agit que sur `NaN`. | `praytimes.js:86` et `:90` | 100 jours/365 divergents, jusqu'à 88 min ; saut de 74 min entre le 25 et le 26 mai |

### 🟠 Important

| # | Problème | Où | Preuve |
|---|---|---|---|
| 3 | **Isha jamais annoncée à l'écran du 15 mai au 31 juillet** (77 jours). Sa valeur est inférieure à celle de Maghrib, la recherche la saute. | `app.js:124-132`, `app.js:142` | À 22:12 le 21 juin, l'écran annonce « Fajr (demain) » |
| 4 | **Prière perdue sans aucune alerte** si le service est gelé plus de 2 min à cheval sur l'heure. Aucun rattrapage, aucun message. | `adhan_service.js:73` | Gel 13:43→13:48 avec Dhuhr à 13:45 : zéro déclenchement |
| 5 | **Adhan joué deux fois** si le service redémarre dans la fenêtre de 2 min (la mémoire des déclenchements ne survit pas au redémarrage). | `adhan_service.js:33` | Sonne à 13:45:00, resonne à 13:46:00 après relance |
| 6 | **Interface et service peuvent diverger dès la première modification de config**, sans que rien ne l'attrape. `config.js` et le bloc `CONFIG` du service sont recopiés à la main. | `config.js` vs `adhan_service.js:17-26` | Passage à Hanafi côté interface seule : **75 min d'écart** le 21 juin |

### 🟡 Moyen

| # | Problème | Où |
|---|---|---|
| 7 | **Le cache journalier bascule à 01:00/02:00 du matin, pas à minuit** (clé en date UTC, calcul en date locale). Sauve accidentellement l'Isha d'été, mais avec 34 min de marge seulement. | `adhan_service.js:36`, `app.js:79` |
| 8 | **`webOSRelaunch` non géré** : si l'app tourne déjà en arrière-plan, l'adhan pourrait ne pas partir. *Je ne suis pas sûr* — à tester sur la TV. | `app.js` (absent) |
| 9 | **Dashboard figé** si la fermeture de l'app échoue après une alarme lancée par le service : sortie par `return` sans relancer les timers. | `app.js:301-307` |
| 10 | **`lastTriggerKey` ne mémorise qu'une seule prière** (une chaîne, pas une liste). Fonctionne parce que les prières se suivent, mais fragile. | `app.js:41`, `app.js:228` |
| 11 | **Le réglage haute latitude n'est configurable nulle part** — c'est une valeur par défaut au fond de la bibliothèque. Or c'est le réglage le plus important à Bruxelles. | `praytimes.js:106` |

### 🟢 Latent (pas actif avec ta config, mais présent)

| # | Problème | Où |
|---|---|---|
| 12 | Méthode `Makkah` : `isha: 90` est un nombre de **minutes** rangé dans un champ d'**angles**. La règle de repli le traiterait comme un angle de 90° (portion = 1,5 × la nuit) → résultat absurde. Inutilisé aujourd'hui. | `praytimes.js:21`, `:87-92` |

---

## 9. Choix discutables mais volontaires (ce ne sont **pas** des bugs)

| Choix | Mon avis |
|---|---|
| **Réécrire la bibliothèque** au lieu d'utiliser PrayTimes.js | Défendable pour une TV (6 Ko au lieu de 15). Le cœur est fidèle à 1 minute. Mais on hérite des bugs sans hériter des corrections. |
| **Fajr exclu du son** (`config.js:19`) | Volontaire et documenté (« TV éteinte à cette heure »). Cohérent entre interface et service. |
| **Sondage toutes les 60 s** plutôt que des alarmes programmées | Bon choix : c'est ce qui évite toute dérive de timer long. Coût : 0–60 s de retard, invisible pour un adhan. |
| **Position du soleil calculée une seule fois** (pas d'itération) | 1,05 min d'écart maximum mesuré. Sans importance. |
| **Règle `AngleBased`** plutôt que `NightMiddle` (le défaut officiel) | C'est un choix **religieux**, pas technique — donc le tien, pas le mien. Mais il est aujourd'hui invisible et non modifiable (§8 n°11), **et mal appliqué** (§8 n°2). |
| **Coordonnées Bruxelles** au lieu du centre de Bruxelles | Écart mesuré : 0,2 minute. Aucune importance. |

---

## 10. Ce que je n'ai **pas** pu vérifier

Par honnêteté, voici les limites de cet audit :

1. **Le service survit-il vraiment à la mise en veille de la TV ?** `services.json` ne
   contient aucune directive de démarrage automatique. Sur webOS, un service JS peut
   être arrêté quand il est inactif. **C'est le risque n°1 du projet**, et il ne se
   teste que sur ta vraie TV. Le README l'évoque déjà comme « à vérifier ».
2. **`applicationManager/launch` fonctionne-t-il par-dessus Netflix ?** Selon le
   firmware, ça peut demander des privilèges élevés. Non testable ici.
3. **Le comportement de `webOSRelaunch`** quand l'app tourne déjà (§8 n°8).
4. **La lecture audio** (`app.js:285`) : le fichier `adhan.mp3` fait 4,3 Mo et est
   présent, mais je ne l'ai ni décodé ni joué.
5. **L'horloge de la TV elle-même** : tout le système en dépend, et rien dans le code
   ne la vérifie.

---

## 11. Questions ouvertes — j'ai besoin de tes décisions

Ces points-là ne se cherchent pas dans le code : ils t'appartiennent.

### ⭐ Question principale

**Quelle convention veux-tu pour Fajr et Isha entre le 15 mai et le 31 juillet ?**
C'est une question religieuse, pas technique — je ne peux pas trancher à ta place.
Les quatre conventions utilisées en Europe du Nord, avec ce qu'elles donnent le
21 juin chez toi :

| Convention | Fajr le 21/06 | Isha le 21/06 | Qui l'utilise |
|---|---|---|---|
| **A.** Angle (règle voulue par ce code, une fois réparée) | 03:14 | 00:07 | Répandue, c'est l'intention actuelle |
| **B.** Milieu de la nuit | 01:45 | 01:45 | **Défaut officiel de PrayTimes.org** |
| **C.** Un septième de la nuit | ~00:57 | ~23:05 | Fréquente au Royaume-Uni |
| **D.** Aligner sur une mosquée de Bruxelles | ses horaires | ses horaires | Le plus sûr socialement |

👉 **Mon conseil : l'option D si tu as une mosquée de référence** (leur calendrier
imprimé suffit, je calerai les réglages dessus et je vérifierai les écarts jour par
jour). Sinon **A réparée**, qui respecte l'intention d'origine du code.

### Les deux autres questions, quand tu auras répondu à celle-là

- **Veux-tu que l'écran affiche clairement que Fajr et Isha sont « estimés »** pendant
  ces 77 jours (une petite mention sous l'horaire), ou préfères-tu qu'ils s'affichent
  comme les autres, sans distinction ?
- **Une prière ratée pendant que la TV était éteinte doit-elle être rattrapée ?**
  Aujourd'hui : non, jamais. Ex. : tu allumes la TV à 20:00, Maghrib était à 19:10 →
  rien ne se passe. Tu peux vouloir un rattrapage court (moins de 15 min), ou un
  simple message « Maghrib est passé à 19:10 » sans son.

---

## 12. Ce que je propose pour la phase 2 (à ta validation)

Par ordre de gravité, et **sans rien toucher tant que tu n'as pas dit oui** :

1. 🔴 **Réparer le changement d'heure** — recalculer le fuseau pour la date visée et
   reconstruire le cache à minuit **local**. Corrige les bugs 1 et 7 d'un coup.
2. 🔴 **Réparer la règle haute latitude** — remplacer `night` par `portion` dans les
   deux conditions (`praytimes.js:86` et `:90`), en alignant sur la référence
   officielle. Deux lignes. Supprime le saut de 74 minutes.
3. 🟠 **Gérer l'Isha après minuit** dans l'affichage et le classement des prières.
4. 🟠 **Fusionner les deux configurations en une seule source** — l'interface demande
   ses horaires au service (la méthode `getTimes` existe déjà, elle n'est pas
   branchée). Supprime définitivement le risque de divergence.
5. 🟠 **Mémoriser sur disque les prières déjà jouées** pour éliminer les doublons au
   redémarrage.
6. 🟡 **Exposer `highLats` dans `config.js`** pour que ta décision du §11 soit un
   réglage, pas une modification de bibliothèque.

Et surtout, avant tout ça : **un jeu de tests automatiques** qui rejoue les cinq
scénarios de cet audit (changement d'heure, nuits d'été, redémarrage, gel, minuit).
Les outils que j'ai écrits pour cet audit servent déjà de base — ils font tourner le
**vrai** fichier de service avec une fausse horloge, sans TV.

---

## ANNEXE — Les conventions des nuits d'été : sources religieuses et mesures

*Ajoutée le 17/08/2026, à ta demande. Je relaie des positions savantes et des
résolutions publiées — je n'émets aucun avis religieux.*

### A. Le fondement textuel : tout le monde part du même hadith

En temps normal, les horaires viennent du **hadith de Jibril** (rapporté par
Muslim) : le Prophète ﷺ a prié deux jours de suite aux limites de chaque temps,
puis a dit que le temps de la prière est entre ces deux limites. Isha commence à
la disparition de la lueur rouge (*shafaq*), Fajr à l'aube vraie.

Le problème de Bruxelles, c'est que **ces signes n'apparaissent plus** 52 jours
par an. Le texte que citent alors *tous* les savants, toutes tendances
confondues, est le **hadith du Dajjal**, rapporté par An-Nawwas ibn Sam'ân dans
**Sahih Muslim n° 2937** : il y sera question d'un jour long comme une année. Les
compagnons demandent si la prière d'un seul jour suffira. Le Prophète ﷺ répond
non, et ordonne : **« اقدروا له قدره »** — *estimez-en la mesure*.

Deux enseignements, et c'est là tout le nœud :

1. **La prière reste obligatoire** même quand les signes du ciel disparaissent.
   Aucun savant ne dit le contraire.
2. Le hadith dit **d'estimer**, mais **ne dit pas comment**. C'est pour ça que
   les conventions ci-dessous existent : ce sont des *ijtihad* (efforts
   d'interprétation), et non des textes. Le Conseil européen de la fatwa l'écrit
   noir sur blanc : la question relève de l'ijtihad, **sans texte définitif**.

👉 **Conséquence pratique : il n'y a pas de « bonne réponse » démontrable.
Il y a des avis respectables qui divergent.**

### B. Ce qu'ont décidé les institutions

| Institution | Décision | Ce que ça donne |
|---|---|---|
| **Conseil de Fiqh islamique de la Ligue Islamique Mondiale** (La Mecque, 9e session) | Découpe la Terre en zones. **45°–48°** : les signes restent visibles, on les suit. **48°–66°** : ils disparaissent une partie de l'année → **estimer d'après la terre la plus proche** où ils sont visibles (*aqrab al-bilâd*). | **Bruxelles est à 50,85° → dans la 2e zone.** La règle recommandée n'est donc pas un angle mais un **calage sur ~48°** |
| **Idem, 19e assemblée (8/11/2007)** | Résolution spécifiquement consacrée aux pays **entre 48° et 66°** | Confirme la précédente |
| **Comité mixte Ligue Islamique Mondiale + ICOP, réuni à BRUXELLES en 2009** | A produit des tables pour les villes européennes situées **entre 48,6° et 66,6°**, sur la base de la **formule des 18°** | Le travail le plus proche de ton cas |
| **Conseil européen de la fatwa et de la recherche** (Dublin, 12e session, déc. 2003–janv. 2004, **décret 2/12**) | Confirme le 18°, **mais** déclare ne pas s'opposer à d'autres estimations : **12°**, ou un **intervalle fixe d'1 h 30** entre Maghrib et Isha (et entre Fajr et le lever) | Ouvre officiellement la porte aux autres conventions |
| **Comité des Grands Savants d'Arabie Saoudite** (12e session) | Aux latitudes extrêmes, estimer d'après **la région modérée la plus proche** | Même logique que la LIM |
| **Musulmans de France (ex-UOIF)** | A retenu le **12°**. Arguments : stabilité du calcul toute l'année, allègement de la contrainte, et le verset « Il ne vous a imposé aucune gêne en religion » (Coran 22:78). Initiateur : **Cheikh Faysal Mawlawi** ; portée par **Youssef al-Qaradawi** et **Abdallah Bin Bayyah** ; travaux astronomiques de **Muhammad Hawari** et **Abdelkarim Ruzloune** | Fajr nettement plus tard, Isha nettement plus tôt |

### C. Les conventions, expliquées simplement

Toutes répondent à la même question : *le soleil ne descend plus assez bas, par
quoi remplace-t-on le signe manquant ?*

Valeurs ci-dessous **calculées**, pas estimées : Bruxelles, 21 juin 2026, avec la
bibliothèque officielle PrayTimes.org v2.5.

| Convention | L'idée en une phrase | Fajr 21/06 | Isha 21/06 |
|---|---|---|---|
| **Angle 18°/17°** (ton code) | On garde l'angle et, quand il devient impossible, on prend une fraction de la nuit **proportionnelle à cet angle** (18/60 ≈ 30 % de la nuit). | 03:14 | 00:07 |
| **Angle 18°/18°** (mosquée de Bxl) | Même règle, mais Isha au même angle que Fajr. | 03:14 | **00:15** |
| **Angle 15°** (ISNA) | On admet qu'à ces latitudes l'aube pratique arrive plus tard. | 03:37 | 23:52 |
| **Angle 12°** (CEFR / Musulmans de France) | Le plus permissif des angles. Calcul stable toute l'année, contrainte allégée. | **03:59** | **23:30** |
| **Milieu de la nuit** | Isha ne dépasse jamais le milieu de la nuit, Fajr ne le précède jamais. C'est **le défaut de PrayTimes.org**. | 01:45 | 01:45 |
| **Un septième de la nuit** | On découpe la nuit en 7 : Isha au 1er septième après Maghrib, Fajr au dernier avant le lever. | **04:25** | **23:04** |
| **Terre la plus proche** (*aqrab al-bilâd*) | On prend les horaires de la latitude la plus au nord où les signes existent encore — en pratique **48°**. **C'est ce que recommande la Ligue Islamique Mondiale pour ta zone.** | 02:25 | 00:38 |
| **Jour le plus proche** (*aqrab al-ayyâm*) | On gèle les horaires du **dernier jour** où le signe était visible (le 25 mai) jusqu'à sa réapparition. | 02:05 | 00:42 |
| **Intervalle fixe 1 h 30** | Isha = Maghrib + 1 h 30 ; Fajr = lever − 1 h 30. Validé comme option par la LIM et le CEFR. | 03:59 | 23:30 |

**L'écart total entre la convention la plus tardive et la plus précoce atteint
2 h 40 sur le Fajr** (01:45 au milieu de nuit contre 04:25 au septième de nuit).
Ce n'est pas un détail de réglage : c'est le choix le plus lourd du projet.

### D. 🔎 Mesure : ce qui est réellement pratiqué à Bruxelles

Le **Centre Islamique et Culturel de Belgique (Grande Mosquée de Bruxelles)**
publie ses horaires sous la méthode dite « Exécutif des Musulmans de Belgique ».
Relevé le **17 août 2026 : Fajr 04:15, Isha 23:15**.

J'ai cherché quel angle reproduit ces deux valeurs :

| Angle | Fajr calculé | Isha calculé |
|---|---|---|
| 17° | 04:26 | 23:06 |
| 17,5° | 04:21 | 23:11 |
| **18°** | **04:16** ✅ | **23:16** ✅ |
| 18,5° | 04:11 | 23:21 |

**Conclusion : 18° pour Fajr ET pour Isha**, à une minute près sur les deux.

⚠️ **Ton code utilise MWL, c'est-à-dire 18° pour Fajr mais 17° pour Isha**
(`praytimes.js:17`). Résultat : **ton Isha part environ 9 minutes trop tôt**
par rapport à la référence bruxelloise, toute l'année.

Bonne nouvelle : la table des méthodes du projet contient déjà
`Karachi: { fajr: 18, isha: 18 }` (`praytimes.js:20`). **Un seul mot à changer
dans `config.js` aligne les angles.**

**Limite de cette mesure, en toute honnêteté :** c'est **une seule date**, et
le 17 août est **hors** de la période problématique. Elle prouve l'angle, elle
**ne dit rien** de la règle appliquée en juin. Pour trancher ça il faudrait le
calendrier de juin de la mosquée — elle publie des PDF mensuels.

### E. Sources

- [Sahih Muslim 2937 — hadith du Dajjal](https://sunnah.com/muslim:2937a)
- [Prayer Times in High-Latitude Areas — ICOP / Astronomy Center](https://astronomycenter.net/latitude.html?l=en)
- [Determining the Times of Prayer in the High Latitudes — IslamOnline](https://fiqh.islamonline.net/en/determining-the-times-of-prayer-in-the-high-latitudes/)
- [Praying and Fasting at High Latitudes — IslamOnline](https://fiqh.islamonline.net/en/praying-and-fasting-at-high-latitudes/)
- [Résolutions du Conseil de Fiqh islamique de La Mecque](https://studyres.com/doc/7885942/resolutions-of-islamic-fiqh-council-makkah-mukarramah)
- [Summer 'Ishā & Fajr Prayer Times — Islam21c](https://www.islam21c.com/islamic-law/166-summer-isha-a-fajr-prayer-times/)
- [UK & Europe Ramadan / Prayer Timetables — Islam21c](https://www.islam21c.com/seasonal-reminders/ramadan/uk-europe-ramadan-annual-prayer-timetables/)
- [Latitude de détermination de l'horaire du Ichaa et du Soubh — Musulmans de France](https://www.musulmansdefrance.fr/latitude-de-determination-de-lhoraire-du-ichaa-du-soubh/)
- [Pourquoi le 12e degré ? — Saphirnews](https://www.saphirnews.com/Pourquoi-le-12e-degre-de-latitude-pour-determiner-l-horaire-du-Ichaa-et-du-Soubh_a14908.html)
- [Comment déterminer les horaires des prières en Europe ?](http://www.acc63.fr/2015/08/comment-determiner-les-horaires-des-prieres-en-europe/)
- [Centre Islamique et Culturel de Belgique — horaires](https://en.masjidway.com/masjid/967/prayer)
- [Grande Mosquée de Bruxelles — horaires de prière](https://www.lagrandemosqueedebruxelles.be/horaires-de-priere/)
- [Fifteen or Eighteen Degrees — Fiqh Council of North America](https://fiqhcouncil.org/fifteen-or-eighteen-degrees-calculating-prayer-fasting-times-in-islam/)

---

*Audit réalisé le 17/08/2026. Aucun fichier du projet modifié. Scripts de test
écrits hors du projet, dans un dossier temporaire de session.*
