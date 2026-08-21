package be.thoubaine.adhan;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Remet tout en place apres un redemarrage.
 *
 * POURQUOI C'EST INDISPENSABLE ICI, ET PAS UN LUXE : Android efface TOUTES
 * les alarmes programmees a l'extinction. Un appareil fixe au mur redemarre
 * apres chaque coupure de courant, chaque mise a jour du systeme, chaque
 * plantage. Sans ce recepteur, l'appareil se rallume, affiche fidelement les
 * horaires, et ne sonne plus jamais. Panne silencieuse par excellence : rien
 * a l'ecran ne la signale.
 *
 * On rearme depuis la liste gardee sur le disque, sans ouvrir la page web :
 * une semaine d'alarmes reste valable meme si personne ne touche l'appareil.
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        final String action = intent == null ? "" : String.valueOf(intent.getAction());
        Log.i(TAG, "redemarrage detecte (" + action + ")");

        final int armees = AdhanAlarms.armer(context);
        AdhanAlarms.rearmerEssai(context);
        Log.i(TAG, armees + " alarme(s) rearmee(s)");

        // On relance aussi la surveillance : la notification permanente est ce
        // qui autorise l'application a rester vivante.
        try {
            final Intent veille = new Intent(context, AdhanService.class)
                .setAction(AdhanService.ACTION_VEILLE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(veille);
            } else {
                context.startService(veille);
            }
        } catch (Exception e) {
            // Android 12+ interdit de demarrer un service au premier plan
            // depuis l'arriere-plan dans certains cas. Les alarmes, elles,
            // sont armees : l'essentiel est sauf.
            Log.w(TAG, "veille non relancee : " + e.getMessage());
        }
    }
}
