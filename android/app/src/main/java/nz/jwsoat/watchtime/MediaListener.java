package nz.jwsoat.watchtime;

import android.app.Notification;
import android.content.Context;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Captures the media notification of the foreground app (YouTube, Spotify, …)
 * so heartbeats can carry the playing title, not just the app name.
 *
 * <p>Requires the user to grant Notification access (Settings > Notification
 * access). Until that is granted the service is never bound and
 * {@link #titleFor} returns null — heartbeats stay app-name-only, exactly as
 * before.
 *
 * <p>YouTube's media notification carries the video title in EXTRA_TITLE and
 * the channel name in EXTRA_TEXT; we cache both per package and let the
 * watcher attach the freshest entry for the app currently on screen.
 */
public final class MediaListener extends NotificationListenerService {

    private static final int CAP = 16;

    /** package -> latest media title/creator; mutated only on the listener thread. */
    private static final Map<String, long[]> STAMPS = new LinkedHashMap<>(); // pkg -> {ts}
    private static final Map<String, String[]> TITLES = new LinkedHashMap<>(); // pkg -> {title, text}
    private static final Map<String, Boolean> PRESENT = new LinkedHashMap<>(); // pkg -> media notification live?
    private static final Map<String, Integer> NOTIF_IDS = new LinkedHashMap<>(); // pkg -> id of last recorded media notif
    private static volatile boolean bound = false;

    @Override
    public void onListenerConnected() {
        bound = true;
        // Re-seed presence from whatever media notifications are live right now,
        // so a service restart mid-playback doesn't think everything stopped.
        StatusBarNotification[] active = getActiveNotifications();
        int seeded = 0;
        if (active != null) {
            for (StatusBarNotification sbn : active) {
                if (record(sbn, true)) seeded++;
            }
        }
        android.util.Log.i("WTL", "connected: seeded " + seeded + " media notifications");
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        boolean media = record(sbn, true);
        android.util.Log.i("WTL", "posted pkg=" + (sbn == null ? "?" : sbn.getPackageName())
                + " media=" + media);
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        // Only mark absence for genuine media notifications; updates/reposts of
        // the same media session do not fire a removal.
        if (sbn == null) return;
        Notification n = sbn.getNotification();
        boolean media = n != null && n.extras != null
                && n.extras.containsKey(Notification.EXTRA_MEDIA_SESSION);
        // YouTube (and possibly others) strip the media-session extra from the
        // notification before removing it, so also match by the id we recorded
        // when the media notification was posted.
        Integer recordedId = NOTIF_IDS.get(sbn.getPackageName());
        boolean matches = media || (recordedId != null && recordedId == sbn.getId());
        android.util.Log.i("WTL", "removed pkg=" + sbn.getPackageName() + " media=" + media
                + " idMatch=" + (recordedId != null && recordedId == sbn.getId()));
        if (!matches) return;
        String pkg = sbn.getPackageName();
        synchronized (TITLES) {
            PRESENT.put(pkg, false);
        }
    }

    /** True when a media notification for pkg is live. When the listener has
     *  never been bound (no Notification access) this returns true so heartbeats
     *  keep the pre-listener behavior of counting app-foreground time. */
    public static boolean isPlaying(Context c, String pkg) {
        if (!bound) return true;
        if (pkg == null) return false;
        synchronized (TITLES) {
            Boolean p = PRESENT.get(pkg);
            return p != null && p;
        }
    }

    /** Record a media notification for pkg; returns true when it was a media
     *  notification (has EXTRA_MEDIA_SESSION) and was recorded. */
    private static boolean record(StatusBarNotification sbn, boolean present) {
        if (sbn == null) return false;
        String pkg = sbn.getPackageName();
        Notification n = sbn.getNotification();
        if (n == null || n.extras == null) return false;
        if (!n.extras.containsKey(Notification.EXTRA_MEDIA_SESSION)) return false;
        CharSequence t = n.extras.getCharSequence(Notification.EXTRA_TITLE);
        if (t == null || t.length() == 0) return false;
        CharSequence x = n.extras.getCharSequence(Notification.EXTRA_TEXT);
        synchronized (TITLES) {
            TITLES.remove(pkg);
            STAMPS.remove(pkg);
            PRESENT.put(pkg, present);
            NOTIF_IDS.put(pkg, sbn.getId());
            TITLES.put(pkg, new String[]{t.toString(), x == null ? null : x.toString()});
            STAMPS.put(pkg, new long[]{System.currentTimeMillis()});
            while (TITLES.size() > CAP) {
                String oldest = TITLES.keySet().iterator().next();
                TITLES.remove(oldest);
                STAMPS.remove(oldest);
            }
        }
        return true;
    }

    /** Latest media info known for pkg, or null: {videoTitle, creator}. */
    public static String[] partsFor(Context c, String pkg) {
        if (pkg == null) return null;
        synchronized (TITLES) {
            String[] e = TITLES.get(pkg);
            long[] ts = STAMPS.get(pkg);
            if (e == null || ts == null) return null;
            // stale beyond 2h: the notification could be from an old session
            if (System.currentTimeMillis() - ts[0] > 2 * 60 * 60 * 1000L) return null;
            String title = e[0];
            String creator = e[1];
            if (creator != null && (creator.length() == 0 || creator.equals(title))) creator = null;
            return new String[]{title, creator};
        }
    }
}
