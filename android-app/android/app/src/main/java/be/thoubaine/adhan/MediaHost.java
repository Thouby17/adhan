package be.thoubaine.adhan;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Enumeration;
import java.util.Locale;

/**
 * Minuscule serveur HTTP, le temps d'un adhan.
 *
 * POURQUOI IL FAUT UN SERVEUR : on n'envoie pas le son a une barre Cast, on
 * lui donne une ADRESSE et c'est elle qui vient chercher le fichier. Sans ce
 * serveur, il n'y a rien a lui indiquer. Le test de ce soir l'a montre noir
 * sur blanc : la barre est venue telecharger 4 220 Ko depuis le PC.
 *
 * Il n'ecoute que le temps de la lecture, sur un port choisi par le systeme,
 * et ne sert qu'UN seul fichier : rien d'autre du telephone n'est expose.
 */
final class MediaHost {

    private static final String TAG = "MediaHost";
    /**
     * LE point unique, cote Java, du fichier audio.
     *
     * Il doit rester identique a "adhanFile" dans src/app/config.js. Ce n'est
     * pas laisse a la vigilance : npm test compare les deux et echoue s'ils
     * divergent. Sans ce garde-fou, changer d'encodage d'un seul cote
     * laisserait l'APK chercher un fichier qui n'existe plus — et un adhan
     * muet ne se signale jamais.
     */
    static final String RESSOURCE = "public/audio/adhan.m4a";
    static final String NOM = "adhan.m4a";
    private static final String CHEMIN = "/" + NOM;

    /** Type MIME deduit du nom, pour ne le recopier nulle part. */
    static String mime() {
        final String f = NOM.toLowerCase(Locale.ROOT);
        if (f.endsWith(".m4a") || f.endsWith(".mp4") || f.endsWith(".aac")) return "audio/mp4";
        if (f.endsWith(".ogg") || f.endsWith(".opus")) return "audio/ogg";
        if (f.endsWith(".wav")) return "audio/wav";
        return "audio/mpeg";
    }

    private ServerSocket socket;
    private Thread boucle;
    private File fichier;
    private volatile boolean vivant = false;
    private volatile int telechargements = 0;

    /** Rend l'URL a communiquer a la barre, ou null si rien n'a pu demarrer. */
    String demarrer(Context ctx) {
        try {
            fichier = extraire(ctx);
            socket = new ServerSocket(0);          // 0 = le systeme choisit
            socket.setReuseAddress(true);
            vivant = true;

            boucle = new Thread(new Runnable() {
                @Override public void run() { servir(); }
            }, "adhan-http");
            boucle.setDaemon(true);
            boucle.start();

            final String ip = adresseLocale();
            if (ip == null) {
                Log.e(TAG, "aucune adresse reseau : la barre ne pourrait pas nous joindre");
                arreter();
                return null;
            }
            final String url = "http://" + ip + ":" + socket.getLocalPort() + CHEMIN;
            Log.i(TAG, "serveur pret : " + url);
            return url;
        } catch (Exception e) {
            Log.e(TAG, "serveur impossible : " + e.getMessage(), e);
            arreter();
            return null;
        }
    }

    int telechargements() { return telechargements; }

    void arreter() {
        vivant = false;
        try { if (socket != null) socket.close(); } catch (Exception ignored) {}
        socket = null;
    }

    // -----------------------------------------------------------------
    private void servir() {
        while (vivant) {
            Socket client = null;
            try {
                client = socket.accept();
                repondre(client);
            } catch (Exception e) {
                if (vivant) Log.w(TAG, "requete en echec : " + e.getMessage());
            } finally {
                try { if (client != null) client.close(); } catch (Exception ignored) {}
            }
        }
    }

    private void repondre(Socket client) throws IOException {
        client.setSoTimeout(15000);
        final InputStream in = client.getInputStream();
        final OutputStream out = client.getOutputStream();

        // Lecture de l'en-tete, ligne par ligne, jusqu'a la ligne vide.
        final StringBuilder entete = new StringBuilder();
        int c, precedent = -1, vides = 0;
        while ((c = in.read()) != -1 && entete.length() < 8192) {
            entete.append((char) c);
            if (c == '\n') { if (precedent == '\r' || precedent == '\n') { vides++; } }
            else if (c != '\r') { vides = 0; }
            precedent = c;
            if (vides >= 1 && entete.toString().endsWith("\r\n\r\n")) break;
        }
        final String requete = entete.toString();

        if (!requete.startsWith("GET") || !requete.contains(CHEMIN)) {
            ecrire(out, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }

        final long taille = fichier.length();
        long debut = 0, fin = taille - 1;
        boolean partiel = false;

        // Les barres de son demandent souvent une plage : annoncer
        // Accept-Ranges sans savoir y repondre, c'est promettre puis mentir.
        final String plage = enteteValeur(requete, "range");
        if (plage != null && plage.toLowerCase(Locale.ROOT).startsWith("bytes=")) {
            try {
                final String[] p = plage.substring(6).split("-", -1);
                if (p.length > 0 && p[0].length() > 0) {
                    debut = Long.parseLong(p[0].trim());
                    if (p.length > 1 && p[1].length() > 0) fin = Long.parseLong(p[1].trim());
                } else if (p.length > 1 && p[1].length() > 0) {
                    // Trouve en relecture : « bytes=-N » demande les N DERNIERS
                    // octets, pas les N premiers. C'est exactement la requete
                    // qu'un lecteur emet pour trouver l'index d'un MP4 — la
                    // servir a l'envers rejouerait la panne des quatre
                    // telechargements sans lecture.
                    final long n = Long.parseLong(p[1].trim());
                    debut = Math.max(0, taille - n);
                    fin = taille - 1;
                }
                if (debut < 0 || debut >= taille) { debut = 0; fin = taille - 1; }
                if (fin >= taille) fin = taille - 1;
                partiel = true;
            } catch (Exception e) {
                debut = 0; fin = taille - 1; partiel = false;
            }
        }

        final long longueur = fin - debut + 1;
        final StringBuilder rep = new StringBuilder();
        rep.append(partiel ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        rep.append("Content-Type: ").append(mime()).append("\r\n");
        rep.append("Content-Length: ").append(longueur).append("\r\n");
        rep.append("Accept-Ranges: bytes\r\n");
        if (partiel) {
            rep.append("Content-Range: bytes ").append(debut).append('-')
               .append(fin).append('/').append(taille).append("\r\n");
        }
        rep.append("Connection: close\r\n\r\n");
        ecrire(out, rep.toString());

        telechargements++;
        Log.i(TAG, "la barre telecharge le fichier (" + longueur + " octets"
                 + (partiel ? ", plage " + debut + "-" + fin : "") + ")");

        final FileInputStream fis = new FileInputStream(fichier);
        try {
            long aSauter = debut;
            while (aSauter > 0) {
                final long saute = fis.skip(aSauter);
                if (saute <= 0) break;
                aSauter -= saute;
            }
            final byte[] tampon = new byte[32 * 1024];
            long reste = longueur;
            while (reste > 0) {
                final int n = fis.read(tampon, 0, (int) Math.min(tampon.length, reste));
                if (n < 0) break;
                out.write(tampon, 0, n);
                reste -= n;
            }
            out.flush();
        } finally {
            try { fis.close(); } catch (Exception ignored) {}
        }
    }

    private static void ecrire(OutputStream out, String s) throws IOException {
        out.write(s.getBytes(CastProto.UTF8));
        out.flush();
    }

    private static String enteteValeur(String requete, String nom) {
        for (String ligne : requete.split("\r\n")) {
            final int i = ligne.indexOf(':');
            if (i <= 0) continue;
            if (ligne.substring(0, i).trim().equalsIgnoreCase(nom)) {
                return ligne.substring(i + 1).trim();
            }
        }
        return null;
    }

    /**
     * Recopie l'adhan des ressources vers le cache. Un fichier reel permet de
     * repondre a une demande de plage (se positionner au milieu), ce qu'un
     * flux de ressource ne sait pas faire.
     */
    private static File extraire(Context ctx) throws IOException {
        final File cible = new File(ctx.getCacheDir(), NOM);
        final AssetManager am = ctx.getAssets();

        // On ne recopie que si la taille differe : inutile d'ecrire 4 Mo a
        // chaque appel a la priere.
        long tailleSource = -1;
        try {
            tailleSource = am.openFd(RESSOURCE).getLength();
        } catch (Exception ignored) {}
        if (cible.exists() && tailleSource > 0 && cible.length() == tailleSource) {
            return cible;
        }

        final InputStream in = am.open(RESSOURCE);
        final FileOutputStream out = new FileOutputStream(cible);
        try {
            final byte[] tampon = new byte[64 * 1024];
            int n;
            while ((n = in.read(tampon)) > 0) out.write(tampon, 0, n);
            out.flush();
        } finally {
            try { in.close(); } catch (Exception ignored) {}
            try { out.close(); } catch (Exception ignored) {}
        }
        Log.i(TAG, "adhan extrait vers le cache (" + cible.length() + " octets)");
        return cible;
    }

    /** L'adresse de la tablette sur le reseau local, celle que la barre appellera. */
    static String adresseLocale() {
        try {
            final Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                final NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                final Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    final InetAddress a = addrs.nextElement();
                    if (a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    final String s = a.getHostAddress();
                    if (s != null && s.indexOf(':') < 0) return s;   // IPv4
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "adresse locale introuvable : " + e.getMessage());
        }
        return null;
    }
}
