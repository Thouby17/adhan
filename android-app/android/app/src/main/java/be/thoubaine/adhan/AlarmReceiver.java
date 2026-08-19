package be.thoubaine.adhan;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Recoit l'alarme et passe la main au service, tout de suite.
 *
 * Un BroadcastReceiver dispose d'une poignee de secondes avant qu'Android ne
 * le tue : on n'y joue donc AUCUN son et on n'y calcule rien. On demarre le
 * service au premier plan, qui lui a le droit de durer les trois minutes de
 * l'adhan.
 */
public class AlarmReceiver extends BroadcastReceiver {

    private static final String TAG = "AlarmReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        final String priere = intent == null
            ? "" : intent.getStringExtra(AdhanService.EXTRA_PRIERE);
        final long prevue = intent == null ? 0L : intent.getLongExtra("at", 0L);
        final long retard = prevue > 0 ? (System.currentTimeMillis() - prevue) / 1000 : -1;
        Log.i(TAG, "alarme recue : " + priere + " (retard " + retard + " s)");

        final Intent service = new Intent(context, AdhanService.class)
            .setAction(AdhanService.ACTION_JOUER)
            .putExtra(AdhanService.EXTRA_PRIERE, priere == null ? "" : priere);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Exception e) {
            Log.e(TAG, "service non demarrable : " + e.getMessage(), e);
        }
    }
}
