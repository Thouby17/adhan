package be.thoubaine.adhan;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.Charset;

/**
 * Le format de fil de Google Cast, ecrit a la main.
 *
 * POURQUOI PAS LE SDK GOOGLE CAST : il impose les services Google Play (que
 * toutes les tablettes n'ont pas), une permission de localisation pour la
 * decouverte, un selecteur d'appareil a afficher, et sa decouverte devient
 * capricieuse en arriere-plan. Or on connait deja l'adresse de la barre et on
 * doit pouvoir la joindre a 5 h du matin sans que personne ne touche l'ecran.
 *
 * Le protocole tient en peu de choses : des trames prefixees de leur longueur
 * sur quatre octets, contenant un message protobuf a six champs, dont la
 * charge utile est du JSON. C'est exactement ce que parle castv2-client, la
 * bibliotheque avec laquelle la barre du salon a ete validee.
 *
 *   message CastMessage {
 *     protocol_version = 1 (varint, 0)
 *     source_id        = 2 (chaine)
 *     destination_id   = 3 (chaine)
 *     namespace        = 4 (chaine)
 *     payload_type     = 5 (varint, 0 = texte)
 *     payload_utf8     = 6 (chaine)
 *   }
 */
final class CastProto {

    static final Charset UTF8 = Charset.forName("UTF-8");

    static final String NS_CONNEXION = "urn:x-cast:com.google.cast.tp.connection";
    static final String NS_BATTEMENT = "urn:x-cast:com.google.cast.tp.heartbeat";
    static final String NS_RECEPTEUR = "urn:x-cast:com.google.cast.receiver";
    static final String NS_MEDIA     = "urn:x-cast:com.google.cast.media";

    /** Le lecteur multimedia par defaut, present sur tout appareil Cast. */
    static final String APP_MEDIA_DEFAUT = "CC1AD845";

    private CastProto() {}

    // -----------------------------------------------------------------
    // Un message recu
    // -----------------------------------------------------------------
    static final class Message {
        String source = "", destination = "", espace = "", charge = "";
        @Override public String toString() {
            return espace + " <- " + source + " : "
                 + (charge.length() > 200 ? charge.substring(0, 200) + "..." : charge);
        }
    }

    // -----------------------------------------------------------------
    // Encodage
    // -----------------------------------------------------------------
    private static void varint(ByteArrayOutputStream out, long v) {
        while ((v & ~0x7FL) != 0) { out.write((int) ((v & 0x7F) | 0x80)); v >>>= 7; }
        out.write((int) v);
    }

    private static void chaine(ByteArrayOutputStream out, int champ, String s) {
        final byte[] b = s.getBytes(UTF8);
        varint(out, (champ << 3) | 2);   // 2 = delimite par la longueur
        varint(out, b.length);
        out.write(b, 0, b.length);
    }

    static byte[] encoder(String source, String destination, String espace, String charge) {
        final ByteArrayOutputStream m = new ByteArrayOutputStream();
        varint(m, (1 << 3));  m.write(0);          // protocol_version = 0
        chaine(m, 2, source);
        chaine(m, 3, destination);
        chaine(m, 4, espace);
        varint(m, (5 << 3));  m.write(0);          // payload_type = 0 (texte)
        chaine(m, 6, charge);

        final byte[] corps = m.toByteArray();
        final ByteArrayOutputStream trame = new ByteArrayOutputStream();
        // Longueur sur quatre octets, gros-boutiste.
        trame.write((corps.length >>> 24) & 0xFF);
        trame.write((corps.length >>> 16) & 0xFF);
        trame.write((corps.length >>> 8) & 0xFF);
        trame.write(corps.length & 0xFF);
        trame.write(corps, 0, corps.length);
        return trame.toByteArray();
    }

    static void envoyer(OutputStream os, String source, String destination,
                        String espace, String charge) throws IOException {
        final byte[] t = encoder(source, destination, espace, charge);
        synchronized (os) { os.write(t); os.flush(); }
    }

    // -----------------------------------------------------------------
    // Decodage
    // -----------------------------------------------------------------

    /** Lit une trame complete. Bloque jusqu'a l'avoir entiere. */
    static Message lire(InputStream is) throws IOException {
        final DataInputStream d = new DataInputStream(is);
        final int taille = d.readInt();
        // Garde-fou : une trame Cast fait quelques kilo-octets. Une taille
        // aberrante signale un flux desynchronise, pas un gros message ;
        // continuer a lire remplirait la memoire pour rien.
        if (taille < 0 || taille > 1 << 20) {
            throw new IOException("trame de taille invalide : " + taille);
        }
        final byte[] corps = new byte[taille];
        d.readFully(corps);
        return decoder(corps);
    }

    static Message decoder(byte[] b) {
        final Message m = new Message();
        int i = 0;
        while (i < b.length) {
            final long[] cle = varintLu(b, i);
            if (cle == null) break;
            i = (int) cle[1];
            final int champ = (int) (cle[0] >>> 3);
            final int type = (int) (cle[0] & 7);

            if (type == 0) {                       // varint : ignore
                final long[] v = varintLu(b, i);
                if (v == null) break;
                i = (int) v[1];
            } else if (type == 2) {                // chaine
                final long[] len = varintLu(b, i);
                if (len == null) break;
                i = (int) len[1];
                final int n = (int) len[0];
                if (n < 0 || i + n > b.length) break;
                final String s = new String(b, i, n, UTF8);
                i += n;
                switch (champ) {
                    case 2: m.source = s; break;
                    case 3: m.destination = s; break;
                    case 4: m.espace = s; break;
                    case 6: m.charge = s; break;
                    default: break;
                }
            } else {
                break;                             // type inattendu : on arrete
            }
        }
        return m;
    }

    /** Rend { valeur, position suivante } ou null si la donnee est tronquee. */
    private static long[] varintLu(byte[] b, int i) {
        long v = 0;
        int decalage = 0;
        while (i < b.length) {
            final int o = b[i++] & 0xFF;
            v |= ((long) (o & 0x7F)) << decalage;
            if ((o & 0x80) == 0) return new long[]{ v, i };
            decalage += 7;
            if (decalage > 63) return null;
        }
        return null;
    }
}
