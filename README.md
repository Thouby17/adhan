# Adhan TV

App webOS qui joue l'adhan automatiquement à l'heure de chaque prière sur ta TV LG, même si tu es sur Netflix / Twitch / une autre app.

## Configuration actuelle

- **Localisation par défaut** : Bruxelles (50.8503, 4.3517). Chacun règle la
  sienne dans l'écran **Réglages** — elle est enregistrée sur l'appareil, jamais
  dans ce dépôt.
- **Angles** : 18° pour Fajr **et** pour Isha — alignés sur ce que publie la
  Grande Mosquée de Bruxelles, et sur la formule du comité Ligue Islamique
  Mondiale + ICOP réuni à Bruxelles en 2009 pour les latitudes 48,6°–66,6°
- **Nuits d'été** : règle `AngleBased` (fraction de nuit proportionnelle à
  l'angle) — voir `AUDIT.md`, annexe, pour les six autres conventions possibles
- **Asr** : Shafi'i
- **Prières avec son** : Dhuhr, Asr, Maghrib, Isha (Fajr exclu)

### Comment changer un réglage

**Un seul fichier à modifier : `src/app/config.js`.** Puis :

```bash
npm run sync   # recopie config.js et praytimes.js vers src/service/
npm test       # vérifie que tout tient encore debout
```

webOS empaquette l'interface et le service séparément : ils ne peuvent pas
partager un fichier à l'exécution, d'où la copie. `npm test` **échoue** si les
deux exemplaires divergent — c'est le garde-fou qui empêche l'écran d'afficher
une heure et l'adhan d'en sonner une autre.

---

## Tests

```bash
npm test
```

17 tests, sans TV ni matériel. Ils chargent le **vrai** `adhan_service.js` avec
une horloge simulée et rejouent les scénarios qui ont réellement cassé :

| Ce qui est vérifié | Pourquoi |
|---|---|
| Conformité à PrayTimes.org v2.5 sur 365 jours | écart < 2 min, Fajr et Isha inclus |
| Aucun saut d'un jour au lendemain | un bug donnait 74 min d'écart entre le 25 et le 26 mai |
| Les 5 prières restent dans l'ordre chronologique | l'Isha d'été tombe après minuit |
| Changement d'heure (29 mars, 25 octobre) | l'adhan partait 1 h trop tôt / trop tard |
| Une année entière minute par minute | chaque prière sonne une fois, à l'heure |
| Redémarrage du service | ne rejoue pas un adhan déjà passé |

---

## Tester l'interface sans TV

```bash
npm run serve
```

Puis <http://localhost:8080>. Ajouter `#alarm=maghrib` à l'URL pour ouvrir
directement le mode alarme.

---

## Tester sur une tablette

```bash
npm run tablette
```

Produit `adhan-tablette.html` : **un seul fichier**, styles, calcul, interface
et MP3 de l'adhan compris. Il fonctionne **hors ligne**, sans serveur et sans
PC allumé — le calcul des horaires est entièrement local.

Le copier sur la tablette (mail à soi-même, câble USB, Drive) et l'ouvrir dans
le navigateur. Penser à régler la mise en veille de l'écran sur « jamais ».

### ⚠️ Le piège du serveur local

On peut aussi ouvrir `http://<ip-du-pc>:8080/adhan-tablette.html` depuis la
tablette. **Mais par défaut ça ne marche pas** : le pare-feu Windows n'autorise
aucune connexion entrante vers Node.js, et la page **tourne indéfiniment sans
message d'erreur** — rien n'indique que c'est le pare-feu.

Pour l'autoriser, dans un PowerShell **lancé en administrateur** :

```powershell
New-NetFirewallRule -DisplayName "Adhan test 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Profile Private -Action Allow
```

Et pour la retirer ensuite :

```powershell
Remove-NetFirewallRule -DisplayName "Adhan test 8080"
```

Le fichier autonome évite tout ça : **préférer cette voie.**

---

## Préalables (à faire une seule fois)

### 1. Installer ares-cli

```bash
npm install -g @webosose/ares-cli
```

### 2. Configurer la TV

Sur la TV, l'app **Developer Mode** doit être active (Dev Mode Status ON, Key Server ON).
Note l'**IP**, le **port passphrase** et le **port** (souvent 9922).

Sur le PC, enregistrer la TV dans ares-cli :

```bash
ares-setup-device
```

Ajoute un device avec :
- name : `lgtv` (ou ce que tu veux)
- host : IP de la TV
- port : 9922
- username : `prisoner`
- passphrase : la passphrase affichée par l'app Developer Mode

Vérifier :

```bash
ares-device-info -d lgtv
```

### 3. Fournir les fichiers manquants

#### Icônes (obligatoire pour packager)

Place deux PNG dans `src/app/` :
- `icon.png` — 80×80
- `largeIcon.png` — 130×130

Si tu n'en as pas, n'importe quelle image carrée fait l'affaire pour tester. Tu peux convertir une image en PNG aux bonnes dimensions avec n'importe quel éditeur.

#### Fichier audio adhan (obligatoire pour le son)

Place un MP3 ici :
```
src/app/audio/adhan.mp3
```

**Sources libres** (vérifier la licence avant publi) :
- **Archive.org** : https://archive.org/details/AdhanCollection — plusieurs muezzins, généralement domaine public
- **Recherche YouTube → conversion MP3** : "Adhan Mecca", "Adhan Madinah", "Adhan Mishary Alafasy" — usage personnel OK
- **islamcan.com/audio/adhan/** : téléchargements directs

Pour la **Belgique**, l'adhan le plus joué est celui de **Mecca (Sheikh Ali Mulla)** ou **Madinah (Sheikh Abdul Majeed Al Surahi)**.

#### webOSTV.js (lib JS officielle LG)

Crée le dossier `src/app/webOSTVjs-1.2.11/` et place dedans le fichier `webOSTV.js` officiel LG :
- Source : https://webostv.developer.lge.com/develop/tools/webos-tv-library
- Ou récupéré dans n'importe quelle app webOS open-source (cf. `WebOS-Token-Refresh-App` que tu as cloné précédemment)

Si tu ne le mets pas, l'app fonctionne quand même en mode dashboard (le timer JS prend le relais), mais le service background ne pourra pas être appelé proprement depuis l'UI.

---

## Build & install

Depuis le dossier racine `adhan-tv/` :

```bash
# 1. Tester PUIS packager l'IPK (npm run package fait les deux)
npm run package

# Équivalent : npm test && ares-package src/app src/service
# Cela produit : com.thoubaine.adhan_1.0.0_all.ipk

# 2. Installer sur la TV
ares-install -d lgtv com.thoubaine.adhan_1.0.0_all.ipk

# 3. Lancer
ares-launch -d lgtv com.thoubaine.adhan
```

### Debug

```bash
# Ouvre Chrome DevTools sur l'app qui tourne sur la TV
ares-inspect -d lgtv -a com.thoubaine.adhan

# Logs du service background
ares-inspect -d lgtv -s com.thoubaine.adhan.service
```

---

## Comment ça marche

### Mode dashboard (lancement normal)

Quand tu ouvres l'app via le launcher TV, elle affiche :
- L'heure actuelle
- La date
- La prochaine prière + countdown
- Les 5 horaires du jour (cards, avec celle qui sonne en surbrillance)
- Bouton "Tester l'adhan" pour vérifier que l'audio marche
- Bouton "Logs" pour voir les événements

Tant que la TV est allumée et que cette app est ouverte, le timer JS surveille les heures et déclenche l'alarme automatiquement (fallback de premier niveau).

### Mode alarme (déclenché par le service)

Le **service background** (`adhan_service.js`) tourne dès que l'app a été lancée au moins une fois. Il poll toutes les 30s. À l'heure exacte d'une prière listée dans `prayersWithAdhan`, il appelle :

```
luna://com.webos.applicationManager/launch
  id: com.thoubaine.adhan
  params: { mode: "alarm", prayer: "Maghrib" }
```

Cela force le lancement de l'app par-dessus ce que tu regardes (Netflix, Twitch, etc.). L'app détecte les params et passe directement en mode alarme, joue le MP3, et se ferme à la fin (ou quand tu cliques Stop).

---

## Limites connues

| Limite | Explication |
|---|---|
| **TV éteinte** | Le service ne tourne pas — c'est LA limite de fond. Un appareil dédié allumé en permanence (Raspberry Pi) la supprime ; le moteur de calcul est du Node.js et s'y transpose tel quel. |
| **Service tué après mise en veille profonde** | Sur certains modèles webOS, le service Node redémarre à l'allumage. **À vérifier sur la vraie TV** — non testable hors matériel. |
| **Force-launch peut être bloqué** | Selon firmware, `applicationManager/launch` peut nécessiter des privilèges élevés. Si ça ne marche pas en dev mode → root la TV (RootMyTV) + Auto Start de webosbrew. |
| **Prière perdue si le service gèle** | La tolérance est de 2 min (`triggerWindowMinutes`). Au-delà, aucun rattrapage — volontaire : personne ne veut un adhan de trois heures de retard. |
| **Précision** | 0 à 30 s de retard sur le déclenchement (intervalle de sondage). |
| **Horloge de la TV** | Tout en dépend et rien ne la vérifie. Si elle est fausse, les horaires le sont d'autant. |

---

## Roadmap idées

- [ ] Settings page (changer ville/méthode depuis l'UI)
- [ ] Choix du muezzin (multi-MP3)
- [ ] Direction Qibla (boussole calculée depuis lat/lng)
- [ ] Verset/dua qui s'affiche après l'adhan
- [ ] Date hégirienne
- [ ] Iqama (second appel ~15 min après)
- [ ] WoL handler pour Fajr (réveil TV depuis Pi local)
