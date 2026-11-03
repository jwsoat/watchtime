package nz.jwsoat.watchtime;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Restarts the watcher after reboot, after an app update, and on a periodic self-check. */
public class BootReceiver extends BroadcastReceiver {

    private static final long SELF_CHECK_MS = 15 * 60 * 1000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        Context c = context.getApplicationContext();
        String action = intent.getAction();
        boolean restart = action == null
                || Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "nz.jwsoat.watchtime.RESTART".equals(action);

        if (!restart) return;
        if (!Config.enabled(c)) return;
        if (!Watcher.hasUsageAccess(c)) {
            Config.setLastStatus(c, "Not started — usage access missing");
            return;
        }

        scheduleSelfCheck(c);

        if (HeartbeatService.running) return;
        try {
            Intent svc = new Intent(c, HeartbeatService.class);
            svc.setAction(HeartbeatService.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(svc);
            else c.startService(svc);
        } catch (Throwable t) {
            // Android 12+ blocks background FGS starts in some cases; the next
            // user-open or reboot will pick it back up.
            Config.setLastStatus(c, "Restart blocked: " + t.getClass().getSimpleName());
        }
    }

    /** Arm a repeating 15-minute self-check that restarts the service if it died. */
    public static void scheduleSelfCheck(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(c, BootReceiver.class);
            i.setAction("nz.jwsoat.watchtime.RESTART");
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getBroadcast(c, 42, i, flags);
            am.setInexactRepeating(AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + SELF_CHECK_MS, SELF_CHECK_MS, pi);
        } catch (Throwable ignored) {
        }
    }

    public static void cancelSelfCheck(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(c, BootReceiver.class);
            i.setAction("nz.jwsoat.watchtime.RESTART");
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getBroadcast(c, 42, i, flags);
            am.cancel(pi);
        } catch (Throwable ignored) {
        }
    }
}
