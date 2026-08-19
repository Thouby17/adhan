package be.thoubaine.adhan;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Les reglages audio, recopies cote natif.
 *
 * POURQUOI UNE COPIE : la source de verite reste config.js + settings.js, du
 * cote de la page web. Mais a 5 h du matin le service joue SANS page chargee :
 * il ne peut donc rien lui demander. La page depose donc ces quelques valeurs
 * ici en meme temps qu'elle programme les alarmes, et le service les relit.
 *
 * La copie ne se met a jour QUE dans ce sens (web vers natif). Rien ici ne
 * doit jamais devenir une seconde source de verite : c'est exactement le
 * piege que le projet combat depuis le debut, quand l'ecran affichait une
 * heure et que le declencheur en sonnait une autre.
 */
final class Reglages {

    private static final String PREFS = "adhan_reglages";

    static final String SORTIE_CAST  = "cast";
    static final String SORTIE_LOCAL = "local";
    static final String SORTIE_DEUX  = "both";

    private Reglages() {}

    private static SharedPreferences p(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void ecrire(Context ctx, String sortie, String hote, double plancher) {
        p(ctx).edit()
            .putString("sortie", sortie == null ? SORTIE_LOCAL : sortie)
            .putString("hote", hote == null ? "" : hote)
            .putFloat("plancher", (float) plancher)
            .apply();
    }

    static String sortie(Context ctx) {
        return p(ctx).getString("sortie", SORTIE_LOCAL);
    }

    static String hote(Context ctx) {
        final String h = p(ctx).getString("hote", "");
        return h == null || h.trim().length() == 0 ? null : h.trim();
    }

    /**
     * L'adresse retrouvee toute seule par mDNS. Gardee a part de celle que
     * l'utilisateur a saisie : on ne veut pas qu'une decouverte ecrase un
     * choix explicite, ni qu'un choix explicite efface ce qu'on a appris.
     */
    static void memoriserHoteTrouve(Context ctx, String ip) {
        p(ctx).edit().putString("hoteTrouve", ip == null ? "" : ip).apply();
    }

    static String hoteTrouve(Context ctx) {
        final String h = p(ctx).getString("hoteTrouve", "");
        return h == null || h.trim().length() == 0 ? null : h.trim();
    }

    /** Volume plancher, ou -1 pour « ne jamais y toucher ». */
    static double plancher(Context ctx) {
        return p(ctx).getFloat("plancher", 0.5f);
    }
}
