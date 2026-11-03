package nz.jwsoat.watchtime;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/** All persisted settings for the agent. */
public final class Config {

    public static final String DEFAULT_BASE_URL = "https://stats.jwsoat.co.nz";

    private static final String PREFS = "watchtime";
    private static final String K_BASE_URL = "base_url";
    private static final String K_API_KEY = "api_key";
    private static final String K_CLIENT_ID = "client_id";
    private static final String K_ENABLED = "enabled";
    private static final String K_TRACKED = "tracked";
    private static final String K_MEDIA_USER = "media_user";
    private static final String K_LAST_STATUS = "last_status";
    private static final String K_LAST_BEAT_AT = "last_beat_at";
    private static final String K_BEATS = "beats_sent";
    private static final String K_QUEUE = "queue";

    private Config() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static String baseUrl(Context c) {
        String v = prefs(c).getString(K_BASE_URL, DEFAULT_BASE_URL);
        if (v == null) v = DEFAULT_BASE_URL;
        v = v.trim();
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        return v;
    }

    public static void setBaseUrl(Context c, String url) {
        prefs(c).edit().putString(K_BASE_URL, url == null ? "" : url.trim()).apply();
    }

    public static String apiKey(Context c) {
        String v = prefs(c).getString(K_API_KEY, "");
        return v == null ? "" : v.trim();
    }

    public static void setApiKey(Context c, String key) {
        prefs(c).edit().putString(K_API_KEY, key == null ? "" : key.trim()).apply();
    }

    /** Stable per-install id, minted once: android-<10 hex>. */
    public static String clientId(Context c) {
        SharedPreferences p = prefs(c);
        String id = p.getString(K_CLIENT_ID, null);
        if (id == null || id.isEmpty()) {
            StringBuilder sb = new StringBuilder("android-");
            for (int i = 0; i < 10; i++) {
                sb.append("0123456789abcdef".charAt((int) (Math.random() * 16)));
            }
            id = sb.toString();
            p.edit().putString(K_CLIENT_ID, id).apply();
        }
        return id;
    }

    /** Account label sent as media_user ("who is watching"); empty = null/unattributed. */
    public static String mediaUser(Context c) {
        String v = prefs(c).getString(K_MEDIA_USER, "");
        return v == null ? "" : v.trim();
    }

    public static void setMediaUser(Context c, String user) {
        prefs(c).edit().putString(K_MEDIA_USER, user == null ? "" : user.trim()).apply();
    }

    public static boolean enabled(Context c) {
        return prefs(c).getBoolean(K_ENABLED, false);
    }

    public static void setEnabled(Context c, boolean enabled) {
        prefs(c).edit().putBoolean(K_ENABLED, enabled).apply();
    }

    public static Set<String> tracked(Context c) {
        Set<String> s = prefs(c).getStringSet(K_TRACKED, null);
        return s == null ? new HashSet<String>() : new HashSet<>(s);
    }

    public static void setTracked(Context c, Set<String> packages) {
        prefs(c).edit().putStringSet(K_TRACKED, new HashSet<>(packages)).apply();
    }

    public static void setTracked(Context c, String pkg, boolean on) {
        Set<String> s = tracked(c);
        if (on) s.add(pkg); else s.remove(pkg);
        setTracked(c, s);
    }

    public static String lastStatus(Context c) {
        return prefs(c).getString(K_LAST_STATUS, "No heartbeat sent yet");
    }

    public static void setLastStatus(Context c, String status) {
        prefs(c).edit().putString(K_LAST_STATUS, status).apply();
    }

    public static long lastBeatAt(Context c) {
        return prefs(c).getLong(K_LAST_BEAT_AT, 0L);
    }

    public static void setLastBeatAt(Context c, long ts) {
        prefs(c).edit().putLong(K_LAST_BEAT_AT, ts).apply();
    }

    public static int beatsSent(Context c) {
        return prefs(c).getInt(K_BEATS, 0);
    }

    public static void bumpBeats(Context c) {
        // commit(): the counter must survive the process being killed right after a beat.
        prefs(c).edit().putInt(K_BEATS, beatsSent(c) + 1).commit();
    }

    static String rawQueue(Context c) {
        return prefs(c).getString(K_QUEUE, "[]");
    }

    static void rawQueue(Context c, String json) {
        // commit(): queued beats must not be lost if the process dies mid-write.
        prefs(c).edit().putString(K_QUEUE, json).commit();
    }
}
