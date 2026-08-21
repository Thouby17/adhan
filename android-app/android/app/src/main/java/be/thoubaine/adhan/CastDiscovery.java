package be.thoubaine.adhan;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.MulticastSocket;
import java.util.ArrayList;
import java.util.List;

/**
 * Retrouve la barre de son toute seule (mDNS).
 *
 * POURQUOI CE N'EST PAS UN LUXE : l'adresse d'un appareil est distribuee par
 * la box et peut changer apres une coupure de courant ou un redemarrage de
 * celle-ci. Une adresse ecrite en dur transformerait chaque incident du
 * quartier en adhan muet — et muet sans le dire, puisque rien a l'ecran ne
 * signalerait quoi que ce soit.
 *
 * On interroge donc le reseau comme le ferait un telephone qui cherche ou
 * diffuser : une question multicast, et on ecoute qui repond.
 */
final class CastDiscovery {

    private static final String TAG = "CastDiscovery";
    private static final String SERVICE = "_googlecast._tcp.local";
    private static final String GROUPE = "224.0.0.251";
    private static final int PORT = 5353;

    static final class Appareil {
        final String ip;
        final String nom;
        Appareil(String ip, String nom) { this.ip = ip; this.nom = nom; }
    }

    private CastDiscovery() {}

    /** Cherche pendant quelques secondes. Rend une liste, eventuellement vide. */
    static List<Appareil> chercher(Context ctx, int secondes) {
        final List<Appareil> trouves = new ArrayList<>();
        WifiManager.MulticastLock verrou = null;
        MulticastSocket socket = null;
        try {
            // Sans ce verrou, Android jette les paquets multicast pour
            // economiser la batterie : la question part et rien ne revient.
            final WifiManager wm = (WifiManager)
                ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                verrou = wm.createMulticastLock("adhan-mdns");
                verrou.setReferenceCounted(true);
                verrou.acquire();
            }

            // ⚠️ setReuseAddress doit preceder le bind : le constructeur
            // MulticastSocket(port) binde IMMEDIATEMENT — l'appel qui suivait
            // etait sans effet, et un port 5353 deja tenu (autre service
            // mDNS, deuxieme recherche simultanee) rendait la decouverte
            // definitivement muette.
            socket = new MulticastSocket(null);
            socket.setReuseAddress(true);
            socket.bind(new java.net.InetSocketAddress(PORT));
            socket.setSoTimeout(700);
            final InetAddress groupe = InetAddress.getByName(GROUPE);
            socket.joinGroup(groupe);

            final byte[] question = question(SERVICE);
            final long fin = System.currentTimeMillis() + secondes * 1000L;
            long prochaineQuestion = 0;

            while (System.currentTimeMillis() < fin) {
                if (System.currentTimeMillis() >= prochaineQuestion) {
                    try {
                        socket.send(new DatagramPacket(question, question.length, groupe, PORT));
                    } catch (Exception ignored) {}
                    prochaineQuestion = System.currentTimeMillis() + 1500;
                }
                try {
                    final byte[] tampon = new byte[4096];
                    final DatagramPacket p = new DatagramPacket(tampon, tampon.length);
                    socket.receive(p);
                    lire(p.getData(), p.getLength(), trouves);
                } catch (Exception ignored) {
                    // Delai ecoule : normal, on repose la question.
                }
            }
            socket.leaveGroup(groupe);
        } catch (Exception e) {
            Log.w(TAG, "recherche impossible : " + e.getMessage());
        } finally {
            try { if (socket != null) socket.close(); } catch (Exception ignored) {}
            try { if (verrou != null && verrou.isHeld()) verrou.release(); } catch (Exception ignored) {}
        }
        Log.i(TAG, trouves.size() + " appareil(s) Cast trouve(s)");
        return trouves;
    }

    // -----------------------------------------------------------------
    // Fabrication de la question
    // -----------------------------------------------------------------
    private static byte[] question(String nom) {
        final ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(0); o.write(0);            // identifiant
        o.write(0); o.write(0);            // drapeaux : simple question
        o.write(0); o.write(1);            // une question
        o.write(0); o.write(0);            // aucune reponse
        o.write(0); o.write(0);
        o.write(0); o.write(0);
        for (String etiquette : nom.split("\\.")) {
            final byte[] b = etiquette.getBytes(CastProto.UTF8);
            o.write(b.length);
            o.write(b, 0, b.length);
        }
        o.write(0);                        // fin du nom
        o.write(0); o.write(12);           // type PTR
        o.write(0); o.write(1);            // classe IN
        return o.toByteArray();
    }

    // -----------------------------------------------------------------
    // Lecture d'une reponse
    // -----------------------------------------------------------------
    private static void lire(byte[] b, int taille, List<Appareil> trouves) {
        try {
            if (taille < 12) return;

            // Trouve en relecture : le port 5353 recoit le trafic mDNS de TOUT
            // le reseau — imprimantes, televiseurs, enceintes. Sans ce filtre,
            // la premiere imprimante qui s'annoncait pendant la recherche
            // devenait « la barre de son ». Un paquet qui parle de Cast
            // contient forcement l'etiquette « _googlecast » en clair au moins
            // une fois (la compression DNS pointe vers une premiere
            // occurrence litterale). ISO-8859-1 : un octet = un caractere,
            // aucun risque de mutiler la recherche.
            final String brut = new String(b, 0, taille,
                java.nio.charset.StandardCharsets.ISO_8859_1);
            if (!brut.contains("_googlecast")) return;
            final int questions = ((b[4] & 0xFF) << 8) | (b[5] & 0xFF);
            int enregistrements = (((b[6] & 0xFF) << 8) | (b[7] & 0xFF))
                                + (((b[8] & 0xFF) << 8) | (b[9] & 0xFF))
                                + (((b[10] & 0xFF) << 8) | (b[11] & 0xFF));
            int i = 12;

            for (int q = 0; q < questions && i < taille; q++) {
                i = sauterNom(b, i, taille);
                i += 4;
            }

            String nomLisible = null;
            final List<String> ips = new ArrayList<>();

            for (int r = 0; r < enregistrements && i < taille; r++) {
                i = sauterNom(b, i, taille);
                if (i + 10 > taille) break;
                final int type = ((b[i] & 0xFF) << 8) | (b[i + 1] & 0xFF);
                final int longueur = ((b[i + 8] & 0xFF) << 8) | (b[i + 9] & 0xFF);
                i += 10;
                if (i + longueur > taille) break;

                if (type == 1 && longueur == 4) {                 // A : une adresse
                    ips.add((b[i] & 0xFF) + "." + (b[i + 1] & 0xFF) + "."
                          + (b[i + 2] & 0xFF) + "." + (b[i + 3] & 0xFF));
                } else if (type == 16) {                          // TXT : le nom affiche
                    int j = i;
                    while (j < i + longueur) {
                        final int n = b[j] & 0xFF;
                        if (n == 0 || j + 1 + n > i + longueur) break;
                        final String s = new String(b, j + 1, n, CastProto.UTF8);
                        if (s.startsWith("fn=")) nomLisible = s.substring(3);
                        j += 1 + n;
                    }
                }
                i += longueur;
            }

            for (String ip : ips) {
                boolean deja = false;
                for (Appareil a : trouves) if (a.ip.equals(ip)) { deja = true; break; }
                if (!deja) trouves.add(new Appareil(ip, nomLisible == null ? "" : nomLisible));
            }
        } catch (Exception e) {
            // Un paquet mal forme sur le reseau ne doit pas interrompre la
            // recherche : d'autres appareils vont repondre.
            Log.w(TAG, "reponse illisible : " + e.getMessage());
        }
    }

    /** Avance au-dela d'un nom, en gerant la compression par pointeur. */
    private static int sauterNom(byte[] b, int i, int taille) {
        while (i < taille) {
            final int n = b[i] & 0xFF;
            if (n == 0) return i + 1;
            if ((n & 0xC0) == 0xC0) return i + 2;   // pointeur : deux octets
            i += 1 + n;
        }
        return i;
    }
}
