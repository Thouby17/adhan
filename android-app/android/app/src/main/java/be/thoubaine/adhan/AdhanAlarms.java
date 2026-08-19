package be.thoubaine.adhan;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Armement des alarmes, et memoire de ce qui est arme.
 *
 * QUI CALCULE LES HORAIRES : la page web, avec praytimes.js. Pas ce fichier.
 * C'est une regle du projet, pas une commodite : le moteur de calcul existe
 * deja en deux exemplaires (ecran et service webOS) et un test echoue s'ils
 * divergent. En porter un troisieme en Java garantirait qu'un jour l'ecran
 * affiche une heure et que l'appareil en sonne une autre. Le natif ne recoit
 * donc que des INSTANTS deja calcules, et se contente de les armer.
 *
 * POURQUOI ON GARDE LA LISTE SUR LE DISQUE : apres une coupure de courant,
 * l'appareil redemarre sans que personne n'ouvre l'application. BootReceiver
 * relit cette liste et rearme tout, sans avoir besoin de la page web.
 */
public final class AdhanAlarms {

    private static final String TAG = "AdhanAlarms";
    private static final String PREFS = "adhan_alarmes";
    private static final String CLE_LISTE = "liste";

    private AdhanAlarms() {}

    // -----------------------------------------------------------------
    // Enregistrement
    // -----------------------------------------------------------------
    public static void enregistrer(Context ctx, JSONArray alarmes) {
        prefs(ctx).edit().putString(CLE_LISTE, alarmes.toString()).apply();
    }

    public static JSONArray lire(Context ctx) {
        final String brut = prefs(ctx).getString(CLE_LISTE, "[]");
        try {
            return new JSONArray(brut);
        } catch (Exception e) {
            Log.w(TAG, "liste illisible, on repart de zero : " + e.getMessage());
            return new JSONArray();
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext()
                  .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // -----------------------------------------------------------------
    // Armement
    // -----------------------------------------------------------------

    /**
     * Arme toutes les alarmes enregistrees qui sont encore a venir.
     * Rend le nombre reellement arme.
     */
    public static int armer(Context ctx) {
        final AlarmManager am =
            (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            Log.e(TAG, "AlarmManager indisponible");
            return 0;
        }

        final JSONArray liste = lire(ctx);
        final long maintenant = System.currentTimeMillis();
        int armees = 0;

        for (int i = 0; i < liste.length(); i++) {
            final JSONObject a = liste.optJSONObject(i);
            if (a == null) continue;
            final long quand = a.optLong("at", 0L);
            final String priere = a.optString("prayer", "");
            if (quand <= maintenant) continue;

            final PendingIntent pi = intentPour(ctx, i, priere, quand);

            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                        && !am.canScheduleExactAlarms()) {
                    // Ne devrait pas arriver : USE_EXACT_ALARM est accordee
                    // d'office a une application de reveil. On degrade quand
                    // meme plutot que de ne rien armer du tout.
                    Log.w(TAG, "alarmes exactes refusees, repli sur approximatif");
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, quand, pi);
                } else {
                    // setAlarmClock : le mecanisme d'un reveil. Android lui
                    // accorde une exemption explicite de Doze et le laisse
                    // sonner a la seconde pres, meme en veille profonde.
                    // C'est la seule variante sur laquelle le systeme s'engage.
                    final PendingIntent voir = PendingIntent.getActivity(
                        ctx, 100000 + i, new Intent(ctx, MainActivity.class),
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                    am.setAlarmClock(new AlarmManager.AlarmClockInfo(quand, voir), pi);
                }
                armees++;
            } catch (SecurityException e) {
                Log.e(TAG, "alarme refusee par le systeme : " + e.getMessage());
            } catch (Exception e) {
                Log.e(TAG, "alarme non armee : " + e.getMessage());
            }
        }

        Log.i(TAG, armees + " alarme(s) armee(s) sur " + liste.length() + " enregistree(s)");
        return armees;
    }

    /** Annule tout ce qui avait ete arme a partir de la liste precedente. */
    public static void desarmer(Context ctx) {
        final AlarmManager am =
            (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        final JSONArray liste = lire(ctx);
        for (int i = 0; i < liste.length(); i++) {
            final JSONObject a = liste.optJSONObject(i);
            if (a == null) continue;
            try {
                am.cancel(intentPour(ctx, i, a.optString("prayer", ""), a.optLong("at", 0L)));
            } catch (Exception ignored) {}
        }
    }

    /**
     * Le code de requete est l'INDICE dans la liste, pas un hachage du
     * contenu : c'est ce qui permet d'annuler exactement ce qu'on avait arme,
     * meme si les horaires ont change entre-temps. Un hachage laisserait des
     * alarmes fantomes impossibles a retrouver.
     */
    private static PendingIntent intentPour(Context ctx, int indice,
                                            String priere, long quand) {
        final Intent i = new Intent(ctx, AlarmReceiver.class)
            .setAction("be.thoubaine.adhan.ALARME." + indice)
            .putExtra(AdhanService.EXTRA_PRIERE, priere)
            .putExtra("at", quand);
        return PendingIntent.getBroadcast(
            ctx, indice, i,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** Combien d'alarmes enregistrees sont encore dans le futur. */
    public static int restantes(Context ctx) {
        final JSONArray liste = lire(ctx);
        final long maintenant = System.currentTimeMillis();
        int n = 0;
        for (int i = 0; i < liste.length(); i++) {
            final JSONObject a = liste.optJSONObject(i);
            if (a != null && a.optLong("at", 0L) > maintenant) n++;
        }
        return n;
    }
}
