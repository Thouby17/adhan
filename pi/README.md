# L'appareil du salon (Raspberry Pi)

Écran fixé au mur qui affiche les horaires de prière en permanence, et joue
l'adhan à l'heure — **même quand la télé est éteinte**.

C'est ce qui règle le défaut de fond de la version TV : un service qui ne
tourne que quand l'écran est allumé rate forcément des prières.

---

## Ce que ça change par rapport à la TV

| | App TV (webOS) | Appareil du salon |
|---|---|---|
| Allumé quand ? | seulement quand la TV l'est | **en permanence** |
| Si le programme meurt | rien ne le relance | **systemd le relance en 10 s** |
| Au redémarrage | il faut rouvrir l'app | **repart tout seul** |
| Le son sort où ? | haut-parleurs de la TV | haut-parleur local **et/ou** barre Samsung en Wi-Fi |

Le calcul des horaires est **exactement le même code** (`src/app/praytimes.js`),
avec **les mêmes réglages** (`src/app/config.js`). Un test vérifie que les deux
programmes déclenchent aux mêmes instants à la seconde près.

---

## Matériel

| Article | Prix relevé le 17/08/2026 |
|---|---|
| Kit Raspberry Pi 5 4 Go (carte + boîtier ventilé + alimentation + câble + carte 32 Go) | 194,00 € |
| Écran tactile IPS 8 pouces, 1280×800 (194 × 119 mm — taille d'un iPad mini) | 82,90 € |

Plus une prise encastrée posée par un électricien, alimentée depuis le tableau
qui se trouve juste derrière le mur.

---

## Installation

### 1. Préparer le Pi

Raspberry Pi OS (64 bits, version Desktop pour l'affichage), puis :

```bash
sudo apt update && sudo apt install -y nodejs npm mpg123 chromium-browser unclutter
```

`mpg123` joue le MP3 · `unclutter` masque le pointeur de souris à l'écran.

### 2. Copier le projet et installer

```bash
cd ~ && git clone <ton-dépôt> adhan-tv    # ou copier le dossier par clé USB
cd ~/adhan-tv/pi && npm install
```

`npm install` récupère `castv2-client`, qui sert à envoyer le son vers la barre.

### 3. Vérifier que le calcul est bon

```bash
cd ~/adhan-tv && npm test
```

20 tests. **Ne pas continuer s'il y a un seul échec.**

### 4. Trouver l'adresse de la barre de son

Sur ta box Internet, cherche l'appareil nommé `Soundbar` ou `HW-Q990F` et note
son adresse IP (du type `192.168.1.x`). Renseigne-la dans
`src/app/config.js` :

```js
castHost: "192.168.1.42",   // remplacer par la vraie adresse
audioOutput: "both",        // haut-parleur local + barre de son
```

💡 Réserve cette adresse dans ta box (« bail statique » / « DHCP réservé »),
sinon elle peut changer et le son s'arrêterait sans prévenir.

### 5. Essayer le son tout de suite

```bash
cd ~/adhan-tv && node pi/adhan-daemon.js --test-son
```

L'adhan doit sortir. Le programme dit **exactement** quelle sortie a marché et
laquelle a échoué :

```
son OK via local
⚠ ÉCHEC via cast : délai dépassé (barre éteinte ou injoignable ?)
```

✅ **Question réglée le 18/08/2026** : la barre HW-Q990F **sort de veille toute
seule en 2 secondes** à la réception d'un flux Cast (vérifié sur l'appareil).
C'est pour ça que `audioOutput` vaut `"cast"` et **qu'aucun haut-parleur
d'appoint n'est nécessaire**.

### 6. Le faire démarrer tout seul

```bash
sudo cp ~/adhan-tv/pi/adhan.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now adhan
systemctl status adhan          # doit afficher "active (running)"
```

⚠️ **Ne pas s'arrêter à « la commande est passée ».** Vérifier le vert de
`systemctl status`, puis regarder les journaux :

```bash
journalctl -u adhan -f
```

Tu dois y voir les horaires du jour, puis une ligne `▶ DHUHR` à l'heure dite.

### 7. L'écran

```bash
chromium-browser --kiosk --incognito http://localhost:8080
```

À lancer au démarrage de la session graphique. L'état du service est aussi
lisible en JSON sur <http://localhost:8081> (horaires du jour, prochaine
prière, sortie audio configurée).

---

## En cas de problème

| Symptôme | Cause probable | Quoi faire |
|---|---|---|
| Aucun son, journal muet | le service ne tourne pas | `systemctl status adhan` |
| `⚠ ÉCHEC via cast` | barre éteinte, ou IP changée | vérifier l'adresse dans la box, réserver le bail |
| `⚠ ÉCHEC via local` | `mpg123` absent ou mauvaise sortie | `sudo apt install mpg123`, puis régler `alsaDevice` |
| Horaires décalés d'une heure | horloge du Pi fausse | `timedatectl` — le fuseau doit être `Europe/Brussels` |
| Adhan joué deux fois | fichier d'état non inscriptible | vérifier `~/.adhan-fired.json` |

Le service **ne meurt jamais** à cause du son ou du serveur d'état : un échec
est journalisé, la prière suivante est quand même programmée.

---

## Changer un réglage

Tout est dans `src/app/config.js` (un seul fichier). Ensuite :

```bash
npm run sync && npm test && sudo systemctl restart adhan
```
