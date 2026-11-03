package nz.jwsoat.watchtime;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Process;

import java.util.List;

/**
 * Foreground-app detection via UsageStats (the same system signal Tasker's App
 * context is built on).
 *
 * <p>Stateful on purpose: it remembers the last known foreground package and only
 * asks the system for events since the previous poll. Asking "what resumed in the
 * last N seconds" per tick is wrong — a user who parks on one app for a minute
 * generates no events at all, and the app would look unknown or fall back to stale
 * aggregate stats.
 */
public final class Watcher {

    private static final long SEED_WINDOW_MS = 5 * 60 * 1000L;

    private long lastQuery;
    private String current;

    /** True when the user has granted Settings > Special access > Usage access. */
    public static boolean hasUsageAccess(Context c) {
        try {
            AppOpsManager ops = (AppOpsManager) c.getSystemService(Context.APP_OPS_SERVICE);
            if (ops == null) return false;
            int mode;
            if (Build.VERSION.SDK_INT >= 29) {
                mode = ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,
                        Process.myUid(), c.getPackageName());
            } else {
                mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,
                        Process.myUid(), c.getPackageName());
            }
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Throwable t) {
            return false;
        }
    }

    /** Package currently in the foreground, or null when nothing recent is known. */
    public String foregroundPackage(Context c) {
        UsageStatsManager usm = (UsageStatsManager) c.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) return null;
        long now = System.currentTimeMillis();
        boolean seed = lastQuery == 0;
        long from = seed ? now - SEED_WINDOW_MS : Math.max(0, lastQuery - 1500L);

        int seen = 0;
        try {
            UsageEvents events = usm.queryEvents(from, now);
            if (events != null) {
                UsageEvents.Event e = new UsageEvents.Event();
                while (events.hasNextEvent()) {
                    events.getNextEvent(e);
                    seen++;
                    int type = e.getEventType();
                    // MOVE_TO_FOREGROUND == ACTIVITY_RESUMED (1); MOVE_TO_BACKGROUND == ACTIVITY_PAUSED (2)
                    if (type == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                        current = e.getPackageName();
                    } else if (type == UsageEvents.Event.MOVE_TO_BACKGROUND) {
                        if (current != null && current.equals(e.getPackageName())) current = null;
                    }
                }
            }
            lastQuery = now;
        } catch (Throwable ignored) {
        }

        if (current != null) return current;

        // Nothing resumed in the window (e.g. the query was blocked). Approximate with
        // the most recently used app, but only while it was used within the last minute.
        if (seen == 0) {
            try {
                List<UsageStats> stats = usm.queryUsageStats(
                        UsageStatsManager.INTERVAL_DAILY, now - 60_000L, now);
                if (stats != null) {
                    long best = 0;
                    String bestPkg = null;
                    for (UsageStats s : stats) {
                        if (s.getLastTimeUsed() > best && now - s.getLastTimeUsed() < 60_000L) {
                            best = s.getLastTimeUsed();
                            bestPkg = s.getPackageName();
                        }
                    }
                    return bestPkg;
                }
            } catch (Throwable ignored) {
            }
        }
        return null;
    }

    /** Human-readable app name used as the heartbeat channel. */
    public static String label(Context c, String pkg) {
        try {
            PackageManager pm = c.getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            CharSequence label = pm.getApplicationLabel(ai);
            if (label != null && label.length() > 0) return label.toString();
        } catch (Throwable ignored) {
        }
        return pkg;
    }
}
