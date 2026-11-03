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

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        record(sbn);
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        // Keep the entry: the notification is replaced constantly during playback,
        // and removing it on a paused session would drop the title mid-watch.
    }

    private static void record(StatusBarNotification sbn) {
        if (sbn == null) return;
        String pkg = sbn.getPackageName();
        Notification n = sbn.getNotification();
        if (n == null || n.extras == null) return;
        boolean media = n.extras.containsKey(Notification.EXTRA_MEDIA_SESSION);
        if (!media) return;
        CharSequence t = n.extras.getCharSequence(Notification.EXTRA_TITLE);
        if (t == null || t.length() == 0) return;
        CharSequence x = n.extras.getCharSequence(Notification.EXTRA_TEXT);
        synchronized (TITLES) {
            TITLES.remove(pkg);
            STAMPS.remove(pkg);
            TITLES.put(pkg, new String[]{t.toString(), x == null ? null : x.toString()});
            STAMPS.put(pkg, new long[]{System.currentTimeMillis()});
            while (TITLES.size() > CAP) {
                String oldest = TITLES.keySet().iterator().next();
                TITLES.remove(oldest);
                STAMPS.remove(oldest);
            }
        }
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
