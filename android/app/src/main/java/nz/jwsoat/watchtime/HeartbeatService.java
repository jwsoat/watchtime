package nz.jwsoat.watchtime;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Foreground service that watches which app is in the foreground and POSTs a
 * watchtime heartbeat every 10s while a tracked app is on screen.
 *
 * <p>Same contract as the Tasker build it replaces: state=active while the app is
 * in front, one state=passive beat when the user leaves it, channel = app name.
 */
public class HeartbeatService extends Service {

    public static final String ACTION_START = "nz.jwsoat.watchtime.START";
    public static final String ACTION_STOP = "nz.jwsoat.watchtime.STOP";

    private static final String CHANNEL_ID = "wt_tracking";
    private static final int NOTIF_ID = 1;
    private static final long TICK_MS = 5_000L;
    private static final long BEAT_MS = 10_000L;

    /** Read by the UI to show whether the watcher is alive. */
    public static volatile boolean running = false;

    private Handler handler;
    private HandlerThread workerThread;
    private PowerManager powerManager;
    private final Watcher watcher = new Watcher();
    private String activeChannel;
    private String activePkg;
    private long lastBeatAt;
    private int sessionBeats;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            try {
                poll();
            } catch (Throwable t) {
                Config.setLastStatus(HeartbeatService.this, "tick error: " + t);
            } finally {
                if (running) handler.postDelayed(this, TICK_MS);
            }
        }
    };

    private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            // Receivers run on the main thread — hand off, because sending a beat does HTTP.
            if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) {
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        closeSession("Idle — screen off");
                    }
                });
            } else if (Intent.ACTION_SCREEN_ON.equals(intent.getAction())) {
                handler.post(tick);
            }
        }
    };

    /** Finish the current session with one passive beat (call from the worker thread only). */
    private void closeSession(String note) {
        if (activeChannel == null) return;
        sendBeat(activePkg, activeChannel, "passive", false);
        activeChannel = null;
        activePkg = null;
        sessionBeats = 0;
        if (note != null) {
            Config.setLastStatus(this, note);
            updateNotification(note);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        // Polling does blocking HTTP, so it must NOT run on the main looper.
        workerThread = new HandlerThread("wt-poll");
        workerThread.start();
        handler = new Handler(workerThread.getLooper());
        powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        createChannel();

        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_SCREEN_OFF);
        registerReceiver(screenReceiver, f);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        startAsForeground("Starting watcher…");
        running = true;

        if (!Config.enabled(this)) {
            Config.setEnabled(this, true);
        }
        Config.setLastStatus(this, "Watcher running");
        handler.removeCallbacks(tick);
        handler.post(tick);
        return START_STICKY;
    }

    private void startAsForeground(String text) {
        Notification n = buildNotification(text);
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Throwable t) {
            // Last-resort: plain foreground start (some OEM builds reject the typed call).
            try {
                startForeground(NOTIF_ID, n);
            } catch (Throwable ignored) {
            }
        }
    }

    private void poll() {
        if (!Config.enabled(this)) {
            android.util.Log.i("WT", "poll: disabled, stopping");
            stopSelf();
            return;
        }
        if (!Watcher.hasUsageAccess(this)) {
            android.util.Log.w("WT", "poll: no usage access");
            Config.setLastStatus(this, "Usage access not granted — open the app to fix");
            updateNotification("Usage access missing");
            return;
        }

        boolean interactive = powerManager == null || powerManager.isInteractive();
        String pkg = interactive ? watcher.foregroundPackage(this) : null;
        boolean tracked = pkg != null && Config.tracked(this).contains(pkg);
        android.util.Log.i("WT", "poll: pkg=" + pkg + " interactive=" + interactive
                + " tracked=" + tracked + " trackedCount=" + Config.tracked(this).size());

        if (tracked) {
            String channel = Watcher.label(this, pkg);
            long now = System.currentTimeMillis();
            if (activeChannel == null || !activeChannel.equals(channel)) {
                if (activeChannel != null) {
                    sendBeat(activePkg, activeChannel, "passive", false);
                    sessionBeats = 0;
                }
                activeChannel = channel;
                activePkg = pkg;
                lastBeatAt = 0;
                sendBeat(pkg, channel, "active", true);
            } else if (now - lastBeatAt >= BEAT_MS) {
                sendBeat(pkg, channel, "active", true);
            }
            String status = "Tracking " + channel + " · " + sessionBeats + " beats"
                    + (lastBeatAt > 0 ? " · " + Config.lastStatus(this) : "");
            Config.setLastStatus(this, status);
            updateNotification(status);
        } else if (activeChannel != null) {
            sendBeat(activePkg, activeChannel, "passive", false);
            activeChannel = null;
            activePkg = null;
            sessionBeats = 0;
            Config.setLastStatus(this, "Idle — " + Config.beatsSent(this) + " beats sent");
            updateNotification("Idle");
        } else {
            updateNotification(idleText(pkg));
        }

        // Opportunistic drain of anything queued while offline.
        if (Uplink.queueSize(this) > 0) Uplink.flush(this);
    }

    private String idleText(String pkg) {
        if (pkg == null) return "Idle — waiting for an app";
        return "Idle — " + Watcher.label(this, pkg) + " (not tracked)";
    }

    private void sendBeat(String pkg, String channel, String state, boolean visible) {
        long ts = System.currentTimeMillis() / 1000L;
        String[] media = MediaListener.partsFor(this, pkg);
        String title = media == null ? null : media[0];
        // When we know the creator (YouTube's media notification text is the channel
        // name), attribute the beat to them — same semantics as the browser extension.
        // No creator known: fall back to the app label.
        if (media != null && media[1] != null) channel = media[1];
        String beat = Heartbeat.beat(ts, channel, title, state, visible,
                Config.clientId(this), channel, Config.mediaUser(this));
        Uplink.Result r = Uplink.send(this, beat);
        android.util.Log.i("WT", "beat " + state + " " + channel
                + (title != null ? " [" + title + "]" : "") + " -> " + r);
        lastBeatAt = System.currentTimeMillis();
        if ("active".equals(state)) sessionBeats++;
        Config.setLastStatus(this, "beat " + state + " → " + channel
                + ": " + (r.ok ? "ok" : r.toString()));
        Config.setLastBeatAt(this, System.currentTimeMillis());
    }

    private void updateNotification(String text) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_ID, buildNotification(text));
        } catch (Throwable ignored) {
        }
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, flags);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle("Watchtime Agent")
                .setContentText(text)
                .setSmallIcon(R.drawable.ic_stat_heart)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(pi)
                .setShowWhen(false);
        return b.build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shows which app watchtime is tracking");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    @Override
    public void onDestroy() {
        running = false;
        try {
            handler.removeCallbacksAndMessages(null);
        } catch (Throwable ignored) {
        }
        try {
            unregisterReceiver(screenReceiver);
        } catch (Throwable ignored) {
        }
        if (activeChannel != null) {
            final String channel = activeChannel;
            final String pkg = activePkg;
            activeChannel = null;
            activePkg = null;
            // onDestroy runs on the main thread; fire the last beat off-thread and give
            // it a moment to complete before the service goes away.
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    sendBeat(pkg, channel, "passive", false);
                }
            });
            t.start();
            try {
                t.join(1500);
            } catch (InterruptedException ignored) {
            }
        }
        try {
            if (workerThread != null) workerThread.quitSafely();
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
