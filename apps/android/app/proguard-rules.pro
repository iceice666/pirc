# kotlinx.serialization keeps its generated serializers via its own consumer rules.

# Debug and verbose logs (terminal diagnostics) are for development builds only.
-assumenosideeffects class android.util.Log {
    public static int d(...);
    public static int v(...);
}
