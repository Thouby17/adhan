package be.thoubaine.adhan;

import android.Manifest;
import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Pont entre la page web et Android.
 *
 * Repartition des roles, volontairement stricte :
 *   - la page web CALCULE les horaires (praytimes.js, source unique) ;
 *   - le natif les ARME, REVEILLE l'appareil et JOUE le son.
 *
 * Aucune heure n'est recalculee de ce cote : voir AdhanAlarms pour le pourquoi.
 */
@CapacitorPlugin(
    name = "Adhan",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS },
                    alias = AdhanPlugin.ALIAS_NOTIFS)
    }
)
public class AdhanPlugin extends Plugin {

    static final String ALIAS_NOTIFS = "notifications";

    /**
     * Le service tourne hors de toute page web et doit pouvoir la prevenir.
     * On garde donc une reference a l'instance vivante du pont ; elle vaut
     * null quand aucune page n'est chargee, ce qui est un cas NORMAL (l'adhan
     * doit sonner meme alors) et jamais une erreur.
     */
    private static AdhanPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    static void diffuser(String priere, boolean actif) {
        final AdhanPlugin p = instance;
        if (p == null) return;
        try {
            p.notifyListeners("adhan", new JSObject()
                .put("priere", priere == null ? "" : priere)
                .put("actif", actif));
        } catch (Exception ignored) {}
    }
    private static final String TAG = "AdhanPlugin";

    // -----------------------------------------------------------------
    // Etat : ce que l'interface a besoin de savoir pour guider l'utilisateur
    // -----------------------------------------------------------------
    @PluginMethod
    public void etat(PluginCall call) {
        final Context ctx = getContext();
        final JSObject r = new JSObject();

        r.put("plateforme", "android");
        r.put("versionAndroid", Build.VERSION.SDK_INT);
        r.put("alarmesArmees", AdhanAlarms.restantes(ctx));
        r.put("alarmesExactes", alarmesExactesPossibles());
        r.put("horsOptimisationBatterie", horsOptimisationBatterie());
        r.put("notifications", getPermissionState(ALIAS_NOTIFS).toString());

        // La prochaine alarme reellement enregistree : c'est la preuve que le
        // natif et l'ecran parlent bien de la meme chose.
        final JSONArray liste = AdhanAlarms.lire(ctx);
        final long maintenant = System.currentTimeMillis();
        long prochaine = 0L;
        String priere = "";
        for (int i = 0; i < liste.length(); i++) {
            final JSONObject a = liste.optJSONObject(i);
            if (a == null) continue;
            final long q = a.optLong("at", 0L);
            if (q > maintenant && (prochaine == 0L || q < prochaine)) {
                prochaine = q;
                priere = a.optString("prayer", "");
            }
        }
        r.put("prochaineAlarme", prochaine);
        r.put("prochainePriere", priere);

        call.resolve(r);
    }

    // -----------------------------------------------------------------
    // Programmation
    // -----------------------------------------------------------------
    @PluginMethod
    public void programmer(PluginCall call) {
        final JSArray alarmes = call.getArray("alarms");
        if (alarmes == null) {
            call.reject("Aucune alarme fournie. Attendu : { alarms: [ { at, prayer } ] }");
            return;
        }
        try {
            final Context ctx = getContext();
            // On desarme d'abord l'ANCIENNE liste, avant de l'ecraser : une
            // fois ecrasee, on ne saurait plus quoi annuler et il resterait
            // des alarmes fantomes qui sonneraient a de vieilles heures.
            AdhanAlarms.desarmer(ctx);
            AdhanAlarms.enregistrer(ctx, alarmes);
            final int armees = AdhanAlarms.armer(ctx);

            demarrerVeilleInterne();

            final JSObject r = new JSObject();
            r.put("recues", alarmes.length());
            r.put("armees", armees);
            call.resolve(r);
        } catch (Exception e) {
            Log.e(TAG, "programmation impossible", e);
            call.reject("Programmation impossible : " + e.getMessage());
        }
    }

    /** Un adhan est-il en train de retentir ? Consulte au chargement de la
     *  page : la diffusion ci-dessus ne peut pas atteindre une page qui
     *  n'existait pas encore au moment du declenchement. */
    @PluginMethod
    public void enCours(PluginCall call) {
        final String p = AdhanService.priereEnCours;
        call.resolve(new JSObject()
            .put("actif", p != null)
            .put("priere", p == null ? "" : p));
    }

    // -----------------------------------------------------------------
    // Lecture
    // -----------------------------------------------------------------
    @PluginMethod
    public void jouer(PluginCall call) {
        final String priere = call.getString("prayer", "");
        final Intent i = new Intent(getContext(), AdhanService.class)
            .setAction(AdhanService.ACTION_JOUER)
            .putExtra(AdhanService.EXTRA_PRIERE, priere);
        demarrerService(i);
        call.resolve();
    }

    @PluginMethod
    public void arreter(PluginCall call) {
        final Intent i = new Intent(getContext(), AdhanService.class)
            .setAction(AdhanService.ACTION_ARRETER);
        demarrerService(i);
        call.resolve();
    }

    @PluginMethod
    public void demarrerVeille(PluginCall call) {
        demarrerVeilleInterne();
        call.resolve();
    }

    // -----------------------------------------------------------------
    // Permissions
    // -----------------------------------------------------------------
    @PluginMethod
    public void demanderNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.resolve(new JSObject().put("accorde", true));
            return;
        }
        requestPermissionForAlias(ALIAS_NOTIFS, call, "retourNotifs");
    }

    @PermissionCallback
    private void retourNotifs(PluginCall call) {
        call.resolve(new JSObject()
            .put("accorde", getPermissionState(ALIAS_NOTIFS).toString().equals("granted")));
    }

    /**
     * Ouvre l'ecran systeme qui permet de sortir l'application de
     * l'optimisation de batterie.
     *
     * On n'utilise PAS ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (la boite de
     * dialogue directe) : Google la reserve a des cas precis et son absence de
     * reponse est indistinguable d'un refus. L'ecran de reglages, lui, marche
     * partout et laisse l'utilisateur voir ce qu'il fait.
     */
    @PluginMethod
    public void demanderExemptionBatterie(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || horsOptimisationBatterie()) {
            call.resolve(new JSObject().put("accorde", true));
            return;
        }
        try {
            final Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:" + getContext().getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve(new JSObject().put("ouvert", true));
        } catch (Exception e) {
            // Certains constructeurs retirent cet ecran : on retombe sur les
            // reglages generaux plutot que d'echouer sans rien proposer.
            try {
                getContext().startActivity(
                    new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                call.resolve(new JSObject().put("ouvert", true));
            } catch (Exception e2) {
                call.reject("Ecran d'optimisation de batterie introuvable sur cet appareil : "
                            + e2.getMessage());
            }
        }
    }

    @PluginMethod
    public void ouvrirReglagesAlarmes(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            call.resolve(new JSObject().put("ouvert", false));
            return;
        }
        try {
            getContext().startActivity(
                new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
                    .setData(Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve(new JSObject().put("ouvert", true));
        } catch (Exception e) {
            call.reject("Ecran des alarmes exactes introuvable : " + e.getMessage());
        }
    }

    // -----------------------------------------------------------------
    // Outils
    // -----------------------------------------------------------------
    private boolean alarmesExactesPossibles() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        final AlarmManager am =
            (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    private boolean horsOptimisationBatterie() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        final PowerManager pm =
            (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private void demarrerVeilleInterne() {
        demarrerService(new Intent(getContext(), AdhanService.class)
            .setAction(AdhanService.ACTION_VEILLE));
    }

    private void demarrerService(Intent i) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(i);
            } else {
                getContext().startService(i);
            }
        } catch (Exception e) {
            Log.e(TAG, "service non demarrable : " + e.getMessage(), e);
        }
    }
}
