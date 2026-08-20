package be.thoubaine.adhan;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

/**
 * L'ecran unique de l'application.
 *
 * Reglages penses pour un appareil FIXE AU MUR :
 *
 *  - l'ecran ne s'eteint pas (FLAG_KEEP_SCREEN_ON). Au-dela du confort, un
 *    ecran allume empeche l'appareil d'entrer en veille profonde, donc en
 *    Doze : le meme geste rend l'affichage utile et le declenchement fiable ;
 *  - l'ecran s'allume et passe par-dessus le verrouillage a l'heure de la
 *    priere (setTurnScreenOn / setShowWhenLocked) ;
 *  - MODE PLEIN ECRAN (« kiosque ») : les barres d'Android — boutons de
 *    navigation en bas, heure et notifications en haut — sont masquees.
 *    C'est le mode « immersif collant » : un glissement depuis le bord les
 *    fait reapparaitre quelques secondes pour regler quelque chose, puis
 *    elles se cachent toutes seules. L'app reste quittable : ce n'est pas
 *    un verrouillage, c'est un affichage propre ;
 *  - le plugin est enregistre AVANT super.onCreate : passe ce point, la
 *    WebView est deja construite et l'enregistrement arriverait trop tard.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AdhanPlugin.class);
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
        }

        masquerBarresSysteme();
    }

    /**
     * Android REMONTRE les barres apres certains evenements (clavier ferme,
     * boite de dialogue, retour d'un autre ecran) sans jamais prevenir.
     * C'est le comportement documente : il faut re-masquer a chaque retour
     * de focus — sans ce rappel, les barres reviennent au bout de quelques
     * heures d'usage et y restent.
     */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) masquerBarresSysteme();
    }

    private void masquerBarresSysteme() {
        try {
            final Window w = getWindow();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                w.setDecorFitsSystemWindows(false);
                final WindowInsetsController c = w.getInsetsController();
                if (c != null) {
                    c.hide(WindowInsets.Type.statusBars()
                         | WindowInsets.Type.navigationBars());
                    // « Par glissement » : le seul comportement qui re-masque
                    // tout seul. Les autres laissent les barres revenues
                    // affichees pour de bon.
                    c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                }
            } else {
                w.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
            }
        } catch (Exception ignored) {
            // Jamais bloquant : mieux vaut des barres visibles qu'un ecran mort.
        }
    }
}
