package be.thoubaine.adhan;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * Service au premier plan : c'est LUI qui joue l'adhan, pas la page web.
 *
 * Pourquoi le natif et pas la balise audio de l'interface : a 5 h du matin, la
 * page web peut ne pas etre chargee, l'ecran peut etre eteint, et Android
 * n'accorde aucune garantie a une WebView en arriere-plan. Un service au
 * premier plan, lui, a le droit de vivre et de produire du son : c'est le
 * mecanisme meme des applications de reveil.
 *
 * ⭐ REFONTE DU CYCLE DE VIE (relecture adverse du 21/08). Le chemin « une
 * seule lecture a la fois » etait solide ; tout ce qui CHEVAUCHAIT deux
 * lectures cassait. Trois principes desormais :
 *
 * 1. GENERATION : chaque demande de lecture incremente un compteur ; les
 *    threads et rappels en vol ne peuvent agir que si leur generation est
 *    encore la generation courante. Un test de reveil chevauche par la vraie
 *    alarme de Fajr ne peut plus couper Fajr.
 * 2. LE SERVICE NE S'ARRETE PLUS APRES UN ADHAN : il REDESCEND en veille
 *    (meme identifiant de notification, contenu mis a jour). L'ancien
 *    stopSelf laissait une notification « surveillance » zombie et tuait la
 *    veille jusqu'a la prochaine visite de la page.
 * 3. EN MODE « CAST », LE HAUT-PARLEUR LOCAL DEMARRE TOUT DE SUITE et se
 *    coupe des que la barre confirme PLAYING : plus jamais 30-60 s de
 *    silence a 5 h pendant que la chaine reseau cherche la barre.
 */
public class AdhanService extends Service {

    private static final String TAG = "AdhanService";
    private static final String CHANNEL_ADHAN = "adhan_appel_v1";
    private static final String CHANNEL_VEILLE = "adhan_veille_v1";
    /** UN SEUL identifiant : deux ids laissaient l'ancienne notification
     *  affichee en zombie quand on passait de veille a adhan. */
    private static final int NOTIF_ID = 1;

    public static final String ACTION_JOUER = "be.thoubaine.adhan.JOUER";
    public static final String ACTION_ARRETER = "be.thoubaine.adhan.ARRETER";
    public static final String ACTION_VEILLE = "be.thoubaine.adhan.VEILLE";
    public static final String EXTRA_PRIERE = "priere";

    /**
     * Priere en cours, lisible par le pont. La page web ne peut pas lire les
     * extras d'un Intent : sans cet etat partage, l'adhan retentirait pendant
     * que l'ecran continue d'afficher l'accueil.
     */
    public static volatile String priereEnCours = null;

    /** La generation courante — voir l'en-tete de classe. */
    private final AtomicInteger generation = new AtomicInteger(0);

    /** Generation du cast en cours, ou -1. Remplace l'ancien booleen
     *  castEnCours, que N'IMPORTE quel thread pouvait fausser. */
    private volatile int castGen = -1;

    private MediaPlayer player;
    private PowerManager.WakeLock veilleEcran;
    private final Handler principal = new Handler(Looper.getMainLooper());

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        creerCanaux();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        final String action = (intent == null || intent.getAction() == null)
            ? ACTION_VEILLE : intent.getAction();

        // Android 14 tue l'application si un service demarre ne passe pas au
        // premier plan dans les secondes qui suivent. On le fait donc AVANT
        // toute autre chose, quelle que soit l'action demandee.
        demarrerAuPremierPlan(ACTION_JOUER.equals(action));

        if (ACTION_ARRETER.equals(action)) {
            // Invalider TOUT ce qui est en vol, transmettre l'arret a la
            // barre (session ADHAN seulement : une ecoute Coran en cours n'a
            // rien demande), puis REDESCENDRE en veille — pas d'arret du
            // service, la surveillance continue.
            generation.incrementAndGet();
            castGen = -1;
            CastSender.arreterAdhan();
            arreterLecture();
            demarrerAuPremierPlan(false);
            return START_STICKY;
        }

        if (ACTION_JOUER.equals(action)) {
            final String priere = intent.getStringExtra(EXTRA_PRIERE);
            reveillerEcran();
            ouvrirEcranAlarme(priere);
            jouer(priere == null ? "" : priere);
        }

        // START_STICKY : si Android nous tue malgre tout (memoire), il nous
        // relance. Un appareil mural doit se remettre debout tout seul.
        return START_STICKY;
    }

    // ---------------------------------------------------------------------
    // Lecture
    // ---------------------------------------------------------------------

    /**
     * REGLE INTANGIBLE : on ne rentre JAMAIS bredouille. Si la barre ne
     * repond pas, si le reseau est tombe, si l'adresse a change — le
     * haut-parleur local joue. Un adhan sur la tablette vaut infiniment
     * mieux qu'un adhan nulle part.
     */
    private void jouer(String enCours) {
        final int gen = generation.incrementAndGet();
        // Un adhan precedent encore en vol sur la barre : on lui transmet
        // l'arret (session ADHAN ciblee — le Coran n'est pas concerne).
        CastSender.arreterAdhan();
        castGen = -1;
        // Liberer le LECTEUR seulement : pas le verrou d'ecran, qui vient
        // d'etre acquis — l'ancienne version le relachait une fraction de
        // seconde apres l'avoir pris.
        arreterLecteurSeul();

        priereEnCours = enCours;
        AdhanPlugin.diffuser(enCours, true);

        final String sortie = Reglages.sortie(this);
        if (Reglages.SORTIE_CAST.equals(sortie) || Reglages.SORTIE_DEUX.equals(sortie)) {
            // Dans les DEUX cas le local demarre tout de suite : en mode
            // « les deux » il joue jusqu'au bout ; en mode « cast » il n'est
            // qu'un filet, coupe des que la barre confirme la lecture.
            final boolean localComplet = Reglages.SORTIE_DEUX.equals(sortie);
            jouerLocal(gen);
            lancerCast(gen, localComplet);
            return;
        }
        jouerLocal(gen);
    }

    private void lancerCast(final int gen, final boolean localComplet) {
        castGen = gen;
        final Context ctx = getApplicationContext();

        // Des que la barre confirme PLAYING, le filet local se coupe (mode
        // « cast » pur uniquement).
        final Runnable surLecture = localComplet ? null : new Runnable() {
            @Override public void run() {
                principal.post(new Runnable() {
                    @Override public void run() {
                        if (generation.get() != gen) return;
                        libererLecteurSansFin();
                        Log.i(TAG, "barre confirmee : le filet local se coupe");
                    }
                });
            }
        };

        final Thread t = new Thread(new Runnable() {
            @Override public void run() {
                final String hote = Reglages.hote(ctx);
                final String appris = Reglages.hoteTrouve(ctx);
                CastSender.Resultat r = null;

                if (hote != null) {
                    r = CastSender.jouer(ctx, hote, Reglages.plancher(ctx), surLecture);
                }
                if ((r == null || !r.ok) && generation.get() == gen
                        && appris != null && !appris.equals(hote)) {
                    r = CastSender.jouer(ctx, appris, Reglages.plancher(ctx), surLecture);
                }
                if ((r == null || !r.ok) && generation.get() == gen) {
                    for (CastDiscovery.Appareil a : CastDiscovery.chercher(ctx, 6)) {
                        if (generation.get() != gen) break;
                        if (a.ip.equals(hote) || a.ip.equals(appris)) continue;
                        r = CastSender.jouer(ctx, a.ip, Reglages.plancher(ctx), surLecture);
                        // ⚠️ On NE memorise PAS cette adresse : le premier
                        // appareil Cast qui accepte peut etre le Chromecast
                        // d'une autre piece — l'adopter durablement sans
                        // confirmation enverrait les adhans suivants au
                        // mauvais endroit.
                        if (r.ok) {
                            Log.i(TAG, "appareil de secours utilise : " + a.ip + " (" + a.nom + ")");
                            break;
                        }
                    }
                }

                final boolean ok = r != null && r.ok;
                Log.i(TAG, "Cast : " + (ok ? "reussi" : "echoue")
                         + (r == null ? "" : " — " + r.detail));

                principal.post(new Runnable() {
                    @Override public void run() {
                        if (generation.get() != gen) return;   // une lecture plus recente a pris la main
                        castGen = -1;
                        // Le cast a fini (ou echoue). Si le lecteur local est
                        // muet — filet deja coupe, ou jamais demarre — c'est
                        // ici que l'adhan se termine ; sinon la fin du local
                        // s'en chargera.
                        if (player == null) finirAdhan(gen);
                    }
                });
            }
        }, "adhan-cast");
        t.setDaemon(true);
        t.start();
    }

    private void jouerLocal(final int gen) {
        try {
            final AssetFileDescriptor afd =
                getAssets().openFd(MediaHost.RESSOURCE);

            player = new MediaPlayer();
            // USAGE_MEDIA et non USAGE_ALARM : le flux alarme ne part pas
            // toujours vers un haut-parleur Bluetooth selon les appareils, et
            // toute la raison d'etre de ce projet est que le son sorte sur la
            // barre du salon. On compense par un volume plancher.
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build());
            player.setDataSource(afd.getFileDescriptor(),
                                 afd.getStartOffset(), afd.getLength());
            afd.close();

            planchierVolume();

            player.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override public void onCompletion(MediaPlayer mp) {
                    if (generation.get() != gen) return;       // lecture perimee
                    Log.i(TAG, "adhan termine (haut-parleur local)");
                    if (castGen == gen) {
                        // La barre diffuse encore : liberer juste le lecteur,
                        // la voie Cast fermera quand ELLE aura fini.
                        libererLecteurSansFin();
                        return;
                    }
                    finirAdhan(gen);
                }
            });
            player.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override public boolean onError(MediaPlayer mp, int what, int extra) {
                    Log.e(TAG, "erreur de lecture " + what + "/" + extra);
                    return false;
                }
            });
            player.prepare();
            player.start();
            Log.i(TAG, "adhan demarre sur le haut-parleur local");
        } catch (Exception e) {
            Log.e(TAG, "lecture impossible : " + e.getMessage(), e);
            // Sans nettoyage, un echec local total laissait le service en
            // notification « Appel a la priere » figee pour toujours. S'il
            // n'y a pas de cast en vol pour prendre le relais, on redescend.
            if (castGen != gen) finirAdhan(gen);
        }
    }

    /** Fin d'un adhan (succes, echec ou arret) : on REDESCEND en veille au
     *  lieu d'arreter le service — la surveillance ne meurt plus. */
    private void finirAdhan(int gen) {
        if (generation.get() != gen) return;
        arreterLecture();
        demarrerAuPremierPlan(false);
    }

    /**
     * Lecon apprise sur la barre de son, transposee ici : un volume laisse
     * tres bas est une panne parfaitement silencieuse. On REMONTE seulement —
     * jamais on ne baisse — et le MEME reglage vaut pour les deux sorties
     * (« ne jamais y toucher » = negatif).
     */
    private void planchierVolume() {
        try {
            final double voulu = Reglages.plancher(this);
            if (voulu < 0) return;
            final AudioManager am =
                (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            final int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            final int actuel = am.getStreamVolume(AudioManager.STREAM_MUSIC);
            final int plancher = (int) Math.round(max * voulu);
            if (actuel < plancher) {
                Log.i(TAG, "volume " + actuel + "/" + max + " remonte a " + plancher);
                am.setStreamVolume(AudioManager.STREAM_MUSIC, plancher, 0);
            }
        } catch (Exception e) {
            Log.w(TAG, "volume non ajustable : " + e.getMessage());
        }
    }

    /** Libere le lecteur SANS clore l'adhan (le cast continue, lui). */
    private void libererLecteurSansFin() {
        if (player != null) {
            try { if (player.isPlaying()) player.stop(); } catch (Exception ignored) {}
            try { player.release(); } catch (Exception ignored) {}
            player = null;
        }
    }

    /** Arret du lecteur + fin annoncee — mais le VERROU D'ECRAN reste :
     *  jouer() l'appelle juste apres reveillerEcran(), et l'ancienne version
     *  relachait le verrou une fraction de seconde apres l'acquisition. */
    private void arreterLecteurSeul() {
        if (priereEnCours != null) {
            priereEnCours = null;
            AdhanPlugin.diffuser("", false);
        }
        libererLecteurSansFin();
    }

    private void arreterLecture() {
        arreterLecteurSeul();
        if (veilleEcran != null && veilleEcran.isHeld()) {
            try { veilleEcran.release(); } catch (Exception ignored) {}
        }
        veilleEcran = null;
    }

    // ---------------------------------------------------------------------
    // Ecran
    // ---------------------------------------------------------------------
    private void reveillerEcran() {
        try {
            final PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            veilleEcran = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                    | PowerManager.ACQUIRE_CAUSES_WAKEUP
                    | PowerManager.ON_AFTER_RELEASE,
                "adhan:ecran");
            // Borne : un verrou d'ecran oublie vide une batterie en une nuit.
            veilleEcran.acquire(5 * 60 * 1000L);
        } catch (Exception e) {
            Log.w(TAG, "ecran non reveillable : " + e.getMessage());
        }
    }

    private void ouvrirEcranAlarme(String priere) {
        try {
            final Intent i = new Intent(this, MainActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                     | Intent.FLAG_ACTIVITY_SINGLE_TOP
                     | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            i.putExtra(EXTRA_PRIERE, priere == null ? "" : priere);
            startActivity(i);
        } catch (Exception e) {
            Log.w(TAG, "ecran d'alarme non ouvrable : " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------------
    // Notifications
    // ---------------------------------------------------------------------
    private void creerCanaux() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        final NotificationManager nm =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        final NotificationChannel appel = new NotificationChannel(
            CHANNEL_ADHAN, "Appel a la priere", NotificationManager.IMPORTANCE_HIGH);
        appel.setDescription("Affiche pendant que l'adhan retentit.");
        appel.setSound(null, null);
        nm.createNotificationChannel(appel);

        final NotificationChannel veille = new NotificationChannel(
            CHANNEL_VEILLE, "Surveillance des horaires", NotificationManager.IMPORTANCE_MIN);
        veille.setDescription(
            "Notification permanente, imposee par Android. C'est elle qui "
            + "autorise l'application a rester vivante et a sonner la nuit.");
        veille.setShowBadge(false);
        nm.createNotificationChannel(veille);
    }

    private void demarrerAuPremierPlan(boolean pendantAdhan) {
        final PendingIntent ouvrir = PendingIntent.getActivity(
            this, 0, new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        final Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, pendantAdhan ? CHANNEL_ADHAN : CHANNEL_VEILLE)
            : new Notification.Builder(this);

        b.setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
         .setContentIntent(ouvrir)
         .setOngoing(true);

        if (pendantAdhan) {
            final PendingIntent stop = PendingIntent.getService(
                this, 1, new Intent(this, AdhanService.class).setAction(ACTION_ARRETER),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.setContentTitle("Appel a la priere");
            b.setContentText("Touche pour ouvrir, ou Arreter pour couper");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                b.addAction(new Notification.Action.Builder(
                    (android.graphics.drawable.Icon) null, "Arreter", stop).build());
            }
        } else {
            b.setContentTitle("Adhan : horaires surveilles");
            b.setContentText("L'application veille pour sonner a l'heure.");
        }

        final Notification n = b.build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n,
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTIF_ID, n);
        }
    }

    @Override
    public void onDestroy() {
        generation.incrementAndGet();
        arreterLecture();
        super.onDestroy();
    }
}
