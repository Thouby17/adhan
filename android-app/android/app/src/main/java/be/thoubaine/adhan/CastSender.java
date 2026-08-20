package be.thoubaine.adhan;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.security.cert.X509Certificate;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Envoie l'adhan a la barre de son, du debut a la fin.
 *
 * Le deroule est celui, exact, qui a fait sonner la barre du salon depuis un
 * PC : connexion, lancement du recepteur, plancher de volume, chargement du
 * media, puis surveillance jusqu'a la derniere seconde.
 *
 * TOUT EST BLOQUANT ET BORNE. Aucune etape ne peut faire attendre
 * indefiniment : au premier depassement, on rend la main et le service
 * repasse sur le haut-parleur local. Mieux vaut un adhan sur la tablette
 * qu'un adhan nulle part.
 */
final class CastSender {

    private static final String TAG = "CastSender";
    private static final int PORT = 8009;
    private static final String MOI = "sender-adhan";
    private static final String RECEPTEUR = "receiver-0";

    /** Ce que l'appel rend : un verdict, et de quoi le journaliser. */
    static final class Resultat {
        final boolean ok;
        final String detail;
        Resultat(boolean ok, String detail) { this.ok = ok; this.detail = detail; }
    }

    private final BlockingQueue<CastProto.Message> recus = new ArrayBlockingQueue<>(200);
    private SSLSocket socket;
    private InputStream in;
    private OutputStream out;
    private volatile boolean vivant = false;
    private int requete = 1;

    /**
     * La session active, pour pouvoir l'ARRETER de l'exterieur.
     *
     * Trouve en relecture : le bouton « Arreter » de la notification coupait
     * l'etat interne du service mais n'envoyait JAMAIS l'ordre a la barre —
     * qui continuait les trois minutes. En pleine nuit, c'est exactement le
     * bouton dont on a besoin, et il ne faisait rien.
     */
    private static volatile CastSender enCoursDeLecture;
    private volatile boolean arretDemande = false;
    private volatile int mediaSession = -1;
    private volatile String transportActif = null;

    /** Demande l'arret de la lecture Cast en cours, s'il y en a une. */
    static void arreterEnCours() {
        final CastSender s = enCoursDeLecture;
        if (s != null) s.arretDemande = true;
    }

    // -----------------------------------------------------------------
    // Point d'entree
    // -----------------------------------------------------------------

    /**
     * @param hote     adresse de la barre (ex. 192.168.1.32)
     * @param plancher volume minimum, ou une valeur negative pour ne jamais y toucher
     */
    static Resultat jouer(Context ctx, String hote, double plancher) {
        final CastSender s = new CastSender();
        final MediaHost serveur = new MediaHost();
        enCoursDeLecture = s;
        try {
            final String url = serveur.demarrer(ctx);
            if (url == null) return new Resultat(false, "serveur local impossible");
            return s.derouler(hote, url, plancher, serveur);
        } catch (Exception e) {
            Log.e(TAG, "echec : " + e.getMessage(), e);
            return new Resultat(false, e.getMessage());
        } finally {
            enCoursDeLecture = null;
            s.fermer();
            serveur.arreter();
        }
    }

    private Resultat derouler(String hote, String url, double plancher, MediaHost serveur)
            throws Exception {

        // --- 1. Connexion ------------------------------------------------
        connecter(hote);
        Log.i(TAG, "connecte a " + hote);

        envoyer(RECEPTEUR, CastProto.NS_CONNEXION, "{\"type\":\"CONNECT\"}");
        envoyer(RECEPTEUR, CastProto.NS_BATTEMENT, "{\"type\":\"PING\"}");

        // --- 2. Lancement du recepteur multimedia -------------------------
        final int reqLaunch = requete++;
        envoyer(RECEPTEUR, CastProto.NS_RECEPTEUR,
            "{\"type\":\"LAUNCH\",\"appId\":\"" + CastProto.APP_MEDIA_DEFAUT
            + "\",\"requestId\":" + reqLaunch + "}");

        String transport = null, session = null;
        Double volumeActuel = null;
        Boolean coupe = null;
        final long finAttente = System.currentTimeMillis() + 15000;

        while (System.currentTimeMillis() < finAttente && transport == null) {
            final CastProto.Message m = attendre(finAttente - System.currentTimeMillis());
            if (m == null) break;
            if (!CastProto.NS_RECEPTEUR.equals(m.espace)) continue;

            final JSONObject j = new JSONObject(m.charge);
            if (!"RECEIVER_STATUS".equals(j.optString("type"))) continue;
            final JSONObject st = j.optJSONObject("status");
            if (st == null) continue;

            final JSONObject vol = st.optJSONObject("volume");
            if (vol != null) {
                volumeActuel = vol.has("level") ? vol.optDouble("level") : null;
                coupe = vol.optBoolean("muted", false);
            }

            final JSONArray apps = st.optJSONArray("applications");
            if (apps == null) continue;
            for (int i = 0; i < apps.length(); i++) {
                final JSONObject a = apps.optJSONObject(i);
                if (a == null) continue;
                if (!CastProto.APP_MEDIA_DEFAUT.equals(a.optString("appId"))) continue;
                transport = a.optString("transportId", null);
                session = a.optString("sessionId", null);
                break;
            }
        }

        if (transport == null || session == null) {
            return new Resultat(false, "le recepteur ne s'est pas lance");
        }
        Log.i(TAG, "recepteur lance (session " + session + ")");

        // --- 3. Plancher de volume ---------------------------------------
        // On NE FIXE PAS le volume : on le remonte s'il est trop bas.
        // La barre annonce controlType "master" : le volume Cast EST son
        // volume maitre. Imposer une valeur ne monte rien, ca ECRASE le
        // reglage de l'utilisateur — c'est le bug qui a rendu l'adhan
        // inaudible pendant que tous les voyants restaient au vert.
        if (plancher >= 0 && volumeActuel != null) {
            if (Boolean.TRUE.equals(coupe) || volumeActuel < plancher) {
                Log.i(TAG, "volume a " + Math.round(volumeActuel * 100)
                         + "% — remonte a " + Math.round(plancher * 100) + "%");
                envoyer(RECEPTEUR, CastProto.NS_RECEPTEUR,
                    "{\"type\":\"SET_VOLUME\",\"volume\":{\"level\":" + plancher
                    + ",\"muted\":false},\"requestId\":" + (requete++) + "}");
            } else {
                Log.i(TAG, "volume a " + Math.round(volumeActuel * 100)
                         + "% — au-dessus du plancher, on n'y touche pas");
            }
        }

        // L'arret peut arriver PENDANT le lancement : dans ce cas on ne
        // charge rien du tout, plutot que de demarrer une lecture que
        // l'utilisateur vient d'interdire.
        if (arretDemande) return new Resultat(false, "arrete avant la lecture");

        // --- 4. Chargement du media --------------------------------------
        transportActif = transport;
        envoyer(transport, CastProto.NS_CONNEXION, "{\"type\":\"CONNECT\"}");

        final JSONObject media = new JSONObject()
            .put("contentId", url)
            .put("contentType", MediaHost.mime())
            .put("streamType", "BUFFERED")
            .put("metadata", new JSONObject()
                .put("type", 0).put("metadataType", 0).put("title", "Adhan"));
        final JSONObject load = new JSONObject()
            .put("type", "LOAD")
            .put("requestId", requete++)
            .put("sessionId", session)
            .put("media", media)
            .put("autoplay", true)
            .put("currentTime", 0);
        envoyer(transport, CastProto.NS_MEDIA, load.toString());

        // --- 5. Surveillance jusqu'a la fin ------------------------------
        // On garde la connexion ouverte : un expediteur qui raccroche laisse
        // certaines barres interrompre la lecture. Et c'est aussi ce qui
        // permet de savoir si le son est reellement parti.
        final long limite = System.currentTimeMillis() + 5 * 60 * 1000;
        long prochainPing = System.currentTimeMillis() + 4000;
        boolean aJoue = false;

        while (System.currentTimeMillis() < limite) {
            // L'utilisateur a appuye sur « Arreter » : on transmet l'ordre a
            // la barre au lieu de simplement raccrocher — raccrocher laisse
            // certaines barres finir le fichier qu'elles ont deja en memoire.
            if (arretDemande) {
                try {
                    if (mediaSession >= 0 && transportActif != null) {
                        envoyer(transportActif, CastProto.NS_MEDIA,
                            "{\"type\":\"STOP\",\"mediaSessionId\":" + mediaSession
                            + ",\"requestId\":" + (requete++) + "}");
                        Thread.sleep(300);   // le temps que l'ordre parte
                    }
                } catch (Exception ignored) {}
                return terminer(aJoue, serveur, "arrete par l'utilisateur");
            }

            final long attente = Math.min(2000, prochainPing - System.currentTimeMillis());
            final CastProto.Message m = attendre(Math.max(200, attente));

            if (System.currentTimeMillis() >= prochainPing) {
                envoyer(RECEPTEUR, CastProto.NS_BATTEMENT, "{\"type\":\"PING\"}");
                prochainPing = System.currentTimeMillis() + 4000;
            }
            if (m == null) continue;

            if (CastProto.NS_BATTEMENT.equals(m.espace)) {
                if (m.charge.contains("PING")) {
                    envoyer(m.source, CastProto.NS_BATTEMENT, "{\"type\":\"PONG\"}");
                }
                continue;
            }
            if (!CastProto.NS_MEDIA.equals(m.espace)) continue;

            final JSONObject j = new JSONObject(m.charge);
            if (!"MEDIA_STATUS".equals(j.optString("type"))) continue;
            final JSONArray st = j.optJSONArray("status");
            if (st == null || st.length() == 0) continue;
            final JSONObject s0 = st.optJSONObject(0);
            if (s0 == null) continue;

            final int ms = s0.optInt("mediaSessionId", -1);
            if (ms >= 0) mediaSession = ms;

            final String etat = s0.optString("playerState", "");
            if ("PLAYING".equals(etat)) aJoue = true;
            if ("IDLE".equals(etat)) {
                final String raison = s0.optString("idleReason", "");
                if (aJoue || raison.length() > 0) {
                    Log.i(TAG, "lecture terminee (" + raison + ")");
                    return terminer(aJoue, serveur, raison);
                }
            }
        }
        return terminer(aJoue, serveur, "delai");
    }

    private Resultat terminer(boolean aJoue, MediaHost serveur, String raison) {
        final int tel = serveur.telechargements();
        // Le vrai critere de succes n'est pas « aucune erreur » mais deux
        // faits observes : la barre est venue chercher le fichier, et elle a
        // annonce PLAYING. C'est la lecon du diagnostic de ce soir.
        final boolean ok = aJoue && tel > 0;
        final String detail = "lecture=" + aJoue + " telechargements=" + tel + " fin=" + raison;
        Log.i(TAG, (ok ? "OK : " : "ECHEC : ") + detail);
        return new Resultat(ok, detail);
    }

    // -----------------------------------------------------------------
    // Coran : envoyer une ADRESSE DISTANTE a la barre
    // -----------------------------------------------------------------

    /**
     * Fait jouer une URL (MP3Quran) par la barre, qui streame TOUTE SEULE :
     * la tablette ne relaie rien.
     *
     * Methode volontairement SEPAREE du chemin de l'adhan : celui-ci est
     * prouve sur l'appareil reel, on ne le destabilise pas pour une autre
     * fonction. Differences assumees : pas de serveur local, pas de plancher
     * de volume (c'est une ecoute choisie, l'utilisateur tient sa
     * telecommande), et une surveillance de DEUX HEURES au lieu de cinq
     * minutes — Al-Baqara seule depasse les deux heures chez certains
     * recitateurs lents, mais la lecture continue meme si la surveillance
     * s'arrete : elle ne sert qu'au bouton « arreter » et au journal.
     *
     * Rend la main des que la lecture a DEMARRE (PLAYING observe) : l'appel
     * vient de l'interface, qui ne peut pas attendre la fin d'une sourate.
     * La surveillance continue dans un fil demon.
     */
    static Resultat jouerUrl(final String hote, String url, String titre) {
        final CastSender s = new CastSender();
        enCoursDeLecture = s;
        try {
            s.connecter(hote);
            s.envoyer(RECEPTEUR, CastProto.NS_CONNEXION, "{\"type\":\"CONNECT\"}");
            s.envoyer(RECEPTEUR, CastProto.NS_RECEPTEUR,
                "{\"type\":\"LAUNCH\",\"appId\":\"" + CastProto.APP_MEDIA_DEFAUT
                + "\",\"requestId\":" + (s.requete++) + "}");

            String transport = null, session = null;
            final long finLancement = System.currentTimeMillis() + 15000;
            while (System.currentTimeMillis() < finLancement && transport == null) {
                final CastProto.Message m = s.attendre(finLancement - System.currentTimeMillis());
                if (m == null) break;
                if (!CastProto.NS_RECEPTEUR.equals(m.espace)) continue;
                final JSONObject j = new JSONObject(m.charge);
                if (!"RECEIVER_STATUS".equals(j.optString("type"))) continue;
                final JSONObject st = j.optJSONObject("status");
                final JSONArray apps = st == null ? null : st.optJSONArray("applications");
                for (int i = 0; apps != null && i < apps.length(); i++) {
                    final JSONObject a = apps.optJSONObject(i);
                    if (a != null && CastProto.APP_MEDIA_DEFAUT.equals(a.optString("appId"))) {
                        transport = a.optString("transportId", null);
                        session = a.optString("sessionId", null);
                        break;
                    }
                }
            }
            if (transport == null || session == null) {
                s.fermer(); enCoursDeLecture = null;
                return new Resultat(false, "le recepteur ne s'est pas lance");
            }

            s.transportActif = transport;
            s.envoyer(transport, CastProto.NS_CONNEXION, "{\"type\":\"CONNECT\"}");
            final JSONObject media = new JSONObject()
                .put("contentId", url)
                .put("contentType", "audio/mpeg")
                .put("streamType", "BUFFERED")
                .put("metadata", new JSONObject()
                    .put("type", 0).put("metadataType", 0)
                    .put("title", titre == null ? "Coran" : titre));
            s.envoyer(transport, CastProto.NS_MEDIA, new JSONObject()
                .put("type", "LOAD").put("requestId", s.requete++)
                .put("sessionId", session).put("media", media)
                .put("autoplay", true).put("currentTime", 0).toString());

            // Attendre le DEMARRAGE reel — « pas d'erreur » ne prouve rien.
            final long finDemarrage = System.currentTimeMillis() + 20000;
            boolean joue = false;
            while (System.currentTimeMillis() < finDemarrage && !joue) {
                final CastProto.Message m = s.attendre(1000);
                if (m == null) continue;
                if (!CastProto.NS_MEDIA.equals(m.espace)) continue;
                final JSONObject j = new JSONObject(m.charge);
                if (!"MEDIA_STATUS".equals(j.optString("type"))) continue;
                final JSONArray st = j.optJSONArray("status");
                final JSONObject s0 = (st == null || st.length() == 0) ? null : st.optJSONObject(0);
                if (s0 == null) continue;
                final int ms = s0.optInt("mediaSessionId", -1);
                if (ms >= 0) s.mediaSession = ms;
                final String etat = s0.optString("playerState", "");
                if ("PLAYING".equals(etat) || "BUFFERING".equals(etat)) joue = true;
                if ("IDLE".equals(etat) && s0.optString("idleReason", "").length() > 0) {
                    s.fermer(); enCoursDeLecture = null;
                    return new Resultat(false, "la barre a refuse le flux ("
                        + s0.optString("idleReason") + ")");
                }
            }
            if (!joue) {
                s.fermer(); enCoursDeLecture = null;
                return new Resultat(false, "lecture jamais demarree");
            }

            // La lecture tourne : surveillance en arriere-plan (battements de
            // coeur + bouton arreter), puis liberation.
            final Thread garde = new Thread(new Runnable() {
                @Override public void run() { s.surveillerUrl(); }
            }, "coran-cast-garde");
            garde.setDaemon(true);
            garde.start();

            return new Resultat(true, "lecture demarree sur " + hote);
        } catch (Exception e) {
            Log.e(TAG, "coran cast : " + e.getMessage(), e);
            s.fermer(); enCoursDeLecture = null;
            return new Resultat(false, String.valueOf(e.getMessage()));
        }
    }

    private void surveillerUrl() {
        try {
            final long limite = System.currentTimeMillis() + 2 * 3600 * 1000;
            long prochainPing = 0;
            while (System.currentTimeMillis() < limite && vivant) {
                if (arretDemande) {
                    try {
                        if (mediaSession >= 0 && transportActif != null) {
                            envoyer(transportActif, CastProto.NS_MEDIA,
                                "{\"type\":\"STOP\",\"mediaSessionId\":" + mediaSession
                                + ",\"requestId\":" + (requete++) + "}");
                            Thread.sleep(300);
                        }
                    } catch (Exception ignored) {}
                    break;
                }
                if (System.currentTimeMillis() >= prochainPing) {
                    envoyer(RECEPTEUR, CastProto.NS_BATTEMENT, "{\"type\":\"PING\"}");
                    prochainPing = System.currentTimeMillis() + 4000;
                }
                final CastProto.Message m = attendre(1500);
                if (m == null) continue;
                if (CastProto.NS_BATTEMENT.equals(m.espace) && m.charge.contains("PING")) {
                    envoyer(m.source, CastProto.NS_BATTEMENT, "{\"type\":\"PONG\"}");
                    continue;
                }
                if (!CastProto.NS_MEDIA.equals(m.espace)) continue;
                final JSONObject j = new JSONObject(m.charge);
                if (!"MEDIA_STATUS".equals(j.optString("type"))) continue;
                final JSONArray st = j.optJSONArray("status");
                final JSONObject s0 = (st == null || st.length() == 0) ? null : st.optJSONObject(0);
                if (s0 != null && "IDLE".equals(s0.optString("playerState", ""))
                        && s0.optString("idleReason", "").length() > 0) {
                    Log.i(TAG, "coran termine (" + s0.optString("idleReason") + ")");
                    break;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "surveillance coran interrompue : " + e.getMessage());
        } finally {
            if (enCoursDeLecture == this) enCoursDeLecture = null;
            fermer();
        }
    }

    // -----------------------------------------------------------------
    // Transport
    // -----------------------------------------------------------------
    private void connecter(String hote) throws Exception {
        socket = (SSLSocket) fabrique().createSocket();
        socket.connect(new InetSocketAddress(hote, PORT), 8000);
        socket.setSoTimeout(0);
        socket.startHandshake();
        in = socket.getInputStream();
        out = socket.getOutputStream();
        vivant = true;

        final Thread lecteur = new Thread(new Runnable() {
            @Override public void run() {
                while (vivant) {
                    try {
                        final CastProto.Message m = CastProto.lire(in);
                        if (!recus.offer(m)) recus.poll();   // on garde les recents
                    } catch (Exception e) {
                        if (vivant) Log.w(TAG, "flux interrompu : " + e.getMessage());
                        vivant = false;
                        return;
                    }
                }
            }
        }, "cast-lecteur");
        lecteur.setDaemon(true);
        lecteur.start();
    }

    /**
     * Les appareils Cast presentent un certificat de l'autorite de Google
     * dediee a Cast, absente du magasin de confiance d'Android : aucun client
     * Cast ne peut donc le valider par la voie normale, et tous procedent
     * ainsi. La portee reste etroite : une adresse du reseau local que
     * l'utilisateur a lui-meme designee, et rien de confidentiel n'y transite
     * — seulement l'adresse d'un fichier audio servi par la tablette.
     */
    private static SSLSocketFactory fabrique() throws Exception {
        final SSLContext ctx = SSLContext.getInstance("TLS");
        ctx.init(null, new TrustManager[]{ new X509TrustManager() {
            @Override public void checkClientTrusted(X509Certificate[] c, String a) {}
            @Override public void checkServerTrusted(X509Certificate[] c, String a) {}
            @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        }}, new java.security.SecureRandom());
        return ctx.getSocketFactory();
    }

    private void envoyer(String destination, String espace, String charge) throws Exception {
        CastProto.envoyer(out, MOI, destination, espace, charge);
    }

    private CastProto.Message attendre(long ms) throws InterruptedException {
        if (ms <= 0) return null;
        return recus.poll(ms, TimeUnit.MILLISECONDS);
    }

    private void fermer() {
        vivant = false;
        try { if (socket != null) socket.close(); } catch (Exception ignored) {}
        socket = null;
    }
}
