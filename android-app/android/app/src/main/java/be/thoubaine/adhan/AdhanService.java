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
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * Service au premier plan : c'est LUI qui joue l'adhan, pas la page web.
 *
 * Pourquoi le natif et pas la balise audio de l'interface : a 5 h du matin, la
 * page web peut ne pas etre chargee, l'ecran peut etre eteint, et Android
 * n'accorde aucune garantie a une WebView en arriere-plan. Un service au
 * premier plan, lui, a le droit de vivre et de produire du son : c'est le
 * mecanisme meme des applications de reveil.
 *
 * Un seul chemin de lecture pour toute l'application. L'interface appelle ce
 * service meme pour son bouton Tester. Deux chemins d'audio, ce serait la
 * garantie qu'un jour l'un des deux marche et pas l'autre.
 */
public class AdhanService extends Service {

    private static final String TAG = "AdhanService";
    private static final String CHANNEL_ADHAN = "adhan_appel_v1";
    private static final String CHANNEL_VEILLE = "adhan_veille_v1";
    private static final int NOTIF_VEILLE = 1;
    private static final int NOTIF_ADHAN = 2;

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

    private MediaPlayer player;
    private PowerManager.WakeLock veilleEcran;

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
            arreterLecture();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
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
    private void jouer(String enCours) {
        arreterLecture();
        try {
            final AssetFileDescriptor afd =
                getAssets().openFd("public/audio/adhan.mp3");

            player = new MediaPlayer();
            // USAGE_MEDIA et non USAGE_ALARM : le flux alarme ne part pas
            // toujours vers un haut-parleur Bluetooth selon les appareils, et
            // toute la raison d'etre de ce projet est que le son sorte sur la
            // barre du salon. On compense par un volume plancher, juste en
            // dessous.
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
                    Log.i(TAG, "adhan termine");
                    arreterLecture();
                    stopForeground(true);
                    stopSelf();
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
            priereEnCours = enCours;
            AdhanPlugin.diffuser(enCours, true);
            Log.i(TAG, "adhan demarre");
        } catch (Exception e) {
            Log.e(TAG, "lecture impossible : " + e.getMessage(), e);
        }
    }

    /**
     * Lecon apprise sur la barre de son, transposee ici.
     *
     * Un volume laisse tres bas produit une panne parfaitement silencieuse :
     * tout fonctionne, rien ne s'entend, et aucun message ne le signale. On
     * remonte donc le volume s'il est sous un plancher, et JAMAIS on ne le
     * baisse : ecraser le reglage de l'utilisateur est precisement le bug qui
     * a coute une soiree cote Cast.
     */
    private void planchierVolume() {
        try {
            final AudioManager am =
                (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            final int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            final int actuel = am.getStreamVolume(AudioManager.STREAM_MUSIC);
            final int plancher = Math.round(max * 0.5f);
            if (actuel < plancher) {
                Log.i(TAG, "volume " + actuel + "/" + max + " remonte a " + plancher);
                am.setStreamVolume(AudioManager.STREAM_MUSIC, plancher, 0);
            }
        } catch (Exception e) {
            // Jamais bloquant : mieux vaut un adhan trop discret que pas d'adhan.
            Log.w(TAG, "volume non ajustable : " + e.getMessage());
        }
    }

    private void arreterLecture() {
        if (priereEnCours != null) {
            priereEnCours = null;
            AdhanPlugin.diffuser("", false);
        }
        if (player != null) {
            try { if (player.isPlaying()) player.stop(); } catch (Exception ignored) {}
            try { player.release(); } catch (Exception ignored) {}
            player = null;
        }
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
        // Le son vient du lecteur, pas de la notification : sinon on entend
        // deux choses a la fois.
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
            b.setContentText("Touchez pour ouvrir, ou Arreter pour couper");
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
            startForeground(pendantAdhan ? NOTIF_ADHAN : NOTIF_VEILLE, n,
                            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(pendantAdhan ? NOTIF_ADHAN : NOTIF_VEILLE, n);
        }
    }

    @Override
    public void onDestroy() {
        arreterLecture();
        super.onDestroy();
    }
}
