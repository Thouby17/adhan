# =====================================================================
# Règles de préservation pour R8 (le réducteur de code d'Android).
#
# R8 supprime tout ce qu'il ne voit personne appeler. Le piège : Capacitor
# n'appelle PAS nos méthodes directement, il les retrouve par RÉFLEXION à
# partir des annotations. R8 ne voit donc aucun appelant, et les efface.
#
# Le symptôme serait le pire possible : l'application s'installe, s'ouvre,
# affiche les horaires — et le pont natif répond « méthode inconnue ». Donc
# pas d'alarme, pas de Cast, et aucun message d'erreur compréhensible.
# =====================================================================

# --- Tout notre code. Il est petit ; le garder entier ne coûte presque rien
#     et supprime toute une classe de pannes silencieuses.
-keep class be.thoubaine.adhan.** { *; }

# --- Capacitor et son pont : entièrement pilotés par réflexion.
-keep class com.getcapacitor.** { *; }
-keep interface com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.PluginMethod public <methods>;
}

# --- Les annotations elles-mêmes : sans elles, la réflexion ne trouve rien.
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# --- Les composants déclarés dans le manifeste sont instanciés par Android,
#     par leur nom. Aucun appel visible dans le code.
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver
-keep public class * extends android.app.Activity

# --- JSON : utilisé par Capacitor et par notre pont Cast.
-keep class org.json.** { *; }

# --- Cordova, présent dans la coquille Capacitor même sans greffon.
-keep class org.apache.cordova.** { *; }
-dontwarn org.apache.cordova.**

# Le bruit des bibliothèques qu'on n'embarque pas ne doit pas faire échouer
# la construction.
-dontwarn javax.annotation.**
-dontwarn org.codehaus.**
