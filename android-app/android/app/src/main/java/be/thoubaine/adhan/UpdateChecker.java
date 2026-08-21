package be.thoubaine.adhan;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Mise a jour de l'application, depuis les publications GitHub du depot.
 *
 * POURQUOI C'EST NECESSAIRE : une application hors Play Store n'a AUCUN
 * mecanisme de mise a jour — Android n'en fournit pas. Sans ce fichier,
 * chaque nouvelle version obligerait a retourner chercher le lien a la main,
 * et une tablette au mur ne previent personne qu'elle est en retard.
 *
 * LECON DES APPS RESTAURANT, appliquee des le premier jour : leur controle de
 * mise a jour echouait EN SILENCE quand l'adresse interrogee est morte — les
 * tablettes sont restees sur leur version pendant des semaines sans que
 * personne ne le voie. Ici, l'echec du controle est journalise ET remonte a
 * l'interface, qui peut l'afficher.
 *
 * La comparaison se fait sur le NUMERO DE VERSION (« 1.2.0 » contre
 * « 1.1.1 »), pas sur l'egalite des chaines : « different » n'est pas
 * « plus recent », et retro-proposer une vieille version serait absurde.
 */
final class UpdateChecker {

    private static final String TAG = "UpdateChecker";
    private static final String API =
        "https://api.github.com/repos/Thouby17/adhan/releases/latest";

    private UpdateChecker() {}

    // -----------------------------------------------------------------
    // Verification
    // -----------------------------------------------------------------

    /**
     * Interroge GitHub et rend l'etat complet. Bloquant (reseau) : a appeler
     * hors du fil principal. Ne jette jamais — rend { ok: false, raison }.
     */
    static JSONObject verifier(Context ctx) {
        final JSONObject r = new JSONObject();
        try {
            final String actuelle = versionActuelle(ctx);
            r.put("actuelle", actuelle);

            final HttpURLConnection c =
                (HttpURLConnection) new URL(API).openConnection();
            // GitHub refuse les requetes sans User-Agent.
            c.setRequestProperty("User-Agent", "adhan-app");
            c.setRequestProperty("Accept", "application/vnd.github+json");
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);

            final int code = c.getResponseCode();
            if (code != 200) {
                return r.put("ok", false)
                        .put("raison", "GitHub a répondu " + code
                             + (code == 403 ? " (limite de requêtes — réessayer plus tard)" : ""));
            }

            // Accumuler les OCTETS puis decoder UNE fois : decoder bloc par
            // bloc coupait un accent a cheval sur deux blocs de 8 Ko.
            final java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            final InputStream in = c.getInputStream();
            final byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();

            final JSONObject rel = new JSONObject(new String(bos.toByteArray(), CastProto.UTF8));
            final String tag = rel.optString("tag_name", "").replaceFirst("^v", "");

            String url = null;
            long taille = 0;
            final JSONArray assets = rel.optJSONArray("assets");
            for (int i = 0; assets != null && i < assets.length(); i++) {
                final JSONObject a = assets.optJSONObject(i);
                if (a != null && a.optString("name", "").endsWith(".apk")) {
                    url = a.optString("browser_download_url", null);
                    taille = a.optLong("size", 0);
                    break;
                }
            }
            if (tag.length() == 0 || url == null) {
                return r.put("ok", false).put("raison", "publication sans APK");
            }

            r.put("ok", true);
            r.put("derniere", tag);
            r.put("url", url);
            r.put("taille", taille);
            r.put("notes", rel.optString("name", ""));
            r.put("plusRecente", plusRecente(tag, actuelle));
            return r;
        } catch (Exception e) {
            Log.w(TAG, "controle impossible : " + e.getMessage());
            try { return r.put("ok", false).put("raison", String.valueOf(e.getMessage())); }
            catch (Exception x) { return r; }
        }
    }

    static String versionActuelle(Context ctx) {
        try {
            return ctx.getPackageManager()
                      .getPackageInfo(ctx.getPackageName(), 0).versionName;
        } catch (Exception e) { return "0"; }
    }

    /** « 1.2.0 » est-il plus recent que « 1.1.1 » ? Numerique, membre a membre. */
    static boolean plusRecente(String candidate, String actuelle) {
        final String[] a = candidate.split("\\.");
        final String[] b = actuelle.split("\\.");
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            final int x = i < a.length ? entier(a[i]) : 0;
            final int y = i < b.length ? entier(b[i]) : 0;
            if (x != y) return x > y;
        }
        return false;
    }

    private static int entier(String s) {
        try { return Integer.parseInt(s.replaceAll("[^0-9]", "")); }
        catch (Exception e) { return 0; }
    }

    // -----------------------------------------------------------------
    // Telechargement et installation
    // -----------------------------------------------------------------

    /**
     * Telecharge l'APK puis ouvre l'installateur d'Android. L'utilisateur
     * garde la main : c'est LUI qui confirme l'ecran d'installation — une
     * application qui se remplacerait sans rien demander serait inquietante,
     * et Android ne le permet de toute facon pas sans droits systeme.
     */
    static JSONObject telechargerEtInstaller(Context ctx, String url) {
        final JSONObject r = new JSONObject();
        try {
            // Android 8+ : l'application doit avoir le droit « installer des
            // applications inconnues ». Sans lui, on ouvre le reglage qui va
            // bien au lieu d'echouer sur un ecran vide.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !ctx.getPackageManager().canRequestPackageInstalls()) {
                final Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:" + ctx.getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(i);
                return r.put("ok", false)
                        .put("autorisationRequise", true)
                        .put("raison", "Autoriser d'abord l'installation, puis réessayer.");
            }

            final File dest = new File(ctx.getCacheDir(), "adhan-maj.apk");
            final HttpURLConnection c =
                (HttpURLConnection) new URL(url).openConnection();
            c.setRequestProperty("User-Agent", "adhan-app");
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(10000);
            c.setReadTimeout(30000);

            final long attendu = c.getContentLengthLong();
            final InputStream in = c.getInputStream();
            final FileOutputStream out = new FileOutputStream(dest);
            final byte[] buf = new byte[64 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); total += n; }
            out.close();
            in.close();
            Log.i(TAG, "APK telechargee : " + total + " octets (annonces : " + attendu + ")");

            // Un telechargement TRONQUE passerait le garde-fou de taille et
            // produirait un « package invalide » incomprehensible a
            // l'installation : comparer a la longueur annoncee.
            if (attendu > 0 && total != attendu) {
                return r.put("ok", false)
                        .put("raison", "téléchargement incomplet (" + total + "/" + attendu
                             + " octets) — réessayer");
            }

            // Garde-fou : une page d'erreur HTML pese quelques Ko, une APK
            // plusieurs Mo. Installer un fichier tronque echouerait avec un
            // message incomprehensible.
            if (total < 500 * 1024) {
                return r.put("ok", false)
                        .put("raison", "téléchargement anormalement petit (" + total + " octets)");
            }

            final Uri uri = FileProvider.getUriForFile(
                ctx, ctx.getPackageName() + ".fileprovider", dest);
            final Intent i = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            ctx.startActivity(i);
            return r.put("ok", true).put("octets", total);
        } catch (Exception e) {
            Log.e(TAG, "mise a jour impossible : " + e.getMessage(), e);
            try { return r.put("ok", false).put("raison", String.valueOf(e.getMessage())); }
            catch (Exception x) { return r; }
        }
    }
}
