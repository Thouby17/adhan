package be.thoubaine.adhan;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

/**
 * L'ecran unique de l'application.
 *
 * Trois reglages qui n'ont rien de cosmetique pour un appareil FIXE AU MUR :
 *
 *  - l'ecran ne s'eteint pas (FLAG_KEEP_SCREEN_ON). Au-dela du confort, un
 *    ecran allume empeche l'appareil d'entrer en veille profonde, donc en
 *    Doze : c'est le meme geste qui rend l'affichage utile et le declenchement
 *    fiable ;
 *  - l'ecran s'allume et passe par-dessus le verrouillage a l'heure de la
 *    priere (setTurnScreenOn / setShowWhenLocked). Sans cela, l'adhan
 *    retentirait devant un ecran noir ;
 *  - le plugin est enregistre AVANT super.onCreate : passe ce point, la
 *    WebView est deja construite et l'enregistrement arrive trop tard.
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
    }
}
