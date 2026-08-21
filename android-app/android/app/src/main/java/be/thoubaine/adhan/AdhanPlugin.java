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
        r.put("sortie", Reglages.sortie(ctx));
        r.put("hote", Reglages.hote(ctx) == null ? "" : Reglages.hote(ctx));
        r.put("hoteTrouve", Reglages.hoteTrouve(ctx) == null ? "" : Reglages.hoteTrouve(ctx));
        r.put("adresseTablette", MediaHost.adresseLocale() == null ? "" : MediaHost.adresseLocale());

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
            final int armees;
            // Serialise : deux programmations rapprochees entrelacaient
            // desarmer/enregistrer/armer. Une ligne ferme le sujet.
            synchronized (AdhanAlarms.class) {
                // On desarme d'abord l'ANCIENNE liste, avant de l'ecraser :
                // une fois ecrasee, on ne saurait plus quoi annuler.
                AdhanAlarms.desarmer(ctx);
                AdhanAlarms.enregistrer(ctx, alarmes);
                armees = AdhanAlarms.armer(ctx);
            }

            // A 5 h du matin le service joue sans page chargee : il ne pourra
            // rien lui demander. Elle depose donc ici ce dont il aura besoin.
            Reglages.ecrire(ctx,
                call.getString("sortie", "local"),
                call.getString("hote", ""),
                call.getDouble("plancher", 0.5d));

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

    /**
     * Cherche les appareils Cast du reseau. Appele depuis l'ecran de reglages,
     * pour que l'utilisateur n'ait pas a connaitre l'adresse de sa barre.
     */
    @PluginMethod
    public void chercherBarres(final PluginCall call) {
        final Context ctx = getContext().getApplicationContext();
        // La recherche dure plusieurs secondes : hors du fil principal, sans
        // quoi l'interface se figerait pendant tout ce temps.
        new Thread(new Runnable() {
            @Override public void run() {
                final JSArray liste = new JSArray();
                try {
                    for (CastDiscovery.Appareil a : CastDiscovery.chercher(ctx, 6)) {
                        liste.put(new JSObject().put("ip", a.ip).put("nom", a.nom));
                    }
                } catch (Exception e) {
                    Log.w(TAG, "recherche impossible : " + e.getMessage());
                }
                call.resolve(new JSObject().put("appareils", liste));
            }
        }, "adhan-recherche").start();
    }

    /** Envoie l'adhan a la barre tout de suite, pour verifier l'installation. */
    @PluginMethod
    public void testerBarre(final PluginCall call) {
        final Context ctx = getContext().getApplicationContext();
        final String hote = call.getString("hote", Reglages.hote(ctx));
        if (hote == null || hote.trim().length() == 0) {
            call.reject("Aucune adresse de barre. Lancez d'abord une recherche.");
            return;
        }
        new Thread(new Runnable() {
            @Override public void run() {
                final CastSender.Resultat r =
                    CastSender.jouerTest(ctx, hote.trim(), Reglages.plancher(ctx));
                call.resolve(new JSObject()
                    .put("ok", r.ok)
                    .put("detail", r.detail == null ? "" : r.detail));
            }
        }, "adhan-test-barre").start();
    }

    @PluginMethod
    public void testerReveil(PluginCall call) {
        final int minutes = call.getInt("minutes", 2);
        final boolean ok = AdhanAlarms.armerEssai(getContext(), minutes);
        final JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("minutes", minutes);
        r.put("quand", System.currentTimeMillis() + minutes * 60000L);
        call.resolve(r);
    }

    // -----------------------------------------------------------------
    // Mises a jour — meme mecanique que les apps restaurant (UpdateChecker),
    // adaptee : la source est GitHub Releases, et l'ECHEC du controle est
    // remonte a l'interface au lieu d'etre silencieux (le silence a laisse
    // les tablettes d'un restaurant sur une vieille version pendant des
    // semaines sans que personne ne le voie).
    // -----------------------------------------------------------------
    @PluginMethod
    public void verifierMiseAJour(final PluginCall call) {
        final Context ctx = getContext().getApplicationContext();
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    call.resolve(JSObject.fromJSONObject(UpdateChecker.verifier(ctx)));
                } catch (Exception e) {
                    call.reject("Contrôle impossible : " + e.getMessage());
                }
            }
        }, "adhan-maj-verif").start();
    }

    @PluginMethod
    public void installerMiseAJour(final PluginCall call) {
        final String url = call.getString("url", "");
        if (url == null || url.length() == 0) {
            call.reject("Aucune adresse de téléchargement.");
            return;
        }
        final Context ctx = getContext().getApplicationContext();
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    call.resolve(JSObject.fromJSONObject(
                        UpdateChecker.telechargerEtInstaller(ctx, url)));
                } catch (Exception e) {
                    call.reject("Installation impossible : " + e.getMessage());
                }
            }
        }, "adhan-maj-install").start();
    }

    // -----------------------------------------------------------------
    // Coran vers la barre : on donne l'ADRESSE a la barre, elle streame
    // toute seule depuis MP3Quran — la tablette ne relaie rien.
    // -----------------------------------------------------------------
    @PluginMethod
    public void coranCast(final PluginCall call) {
        final String url = call.getString("url", "");
        final String titre = call.getString("titre", "Coran");
        if (url == null || url.length() == 0) {
            call.reject("Aucune adresse audio.");
            return;
        }
        final Context ctx = getContext().getApplicationContext();
        final String hote = Reglages.hote(ctx) != null
            ? Reglages.hote(ctx) : Reglages.hoteTrouve(ctx);
        if (hote == null) {
            call.resolve(new JSObject().put("ok", false)
                .put("raison", "aucune barre configurée — Réglages → Chercher ma barre"));
            return;
        }
        // Garder le service de veille debout : sans lui, Android peut tuer
        // le processus en pleine sourate de 2 h — la barre continuerait
        // (elle streame elle-meme) mais le bouton d'arret mourrait en silence.
        demarrerVeilleInterne();
        new Thread(new Runnable() {
            @Override public void run() {
                final CastSender.Resultat r = CastSender.jouerUrl(hote, url, titre);
                call.resolve(new JSObject()
                    .put("ok", r.ok)
                    .put("raison", r.detail == null ? "" : r.detail)
                    .put("hote", hote));
            }
        }, "adhan-coran-cast").start();
    }

    @PluginMethod
    public void coranCastArreter(PluginCall call) {
        CastSender.arreterCoran();
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
