package nz.jwsoat.watchtime;

import android.content.Context;

import org.json.JSONArray;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * HTTP transport for heartbeats, plus a bounded on-disk queue so beats taken while
 * offline (or while the server is down) are delivered later instead of being lost.
 */
public final class Uplink {

    private static final int MAX_QUEUE = 2000;
    private static final int FLUSH_BATCH = 200;
    private static final int TIMEOUT_MS = 12000;

    private Uplink() {}

    public static final class Result {
        public final boolean ok;
        public final int code;
        public final String body;

        Result(boolean ok, int code, String body) {
            this.ok = ok;
            this.code = code;
            this.body = body;
        }

        @Override
        public String toString() {
            return ok ? "ok " + code : "HTTP " + code + " " + body;
        }
    }

    /** POST every queued beat that is still pending. Returns number delivered. */
    public static int flush(Context c) {
        List<String> queued = readQueue(c);
        if (queued.isEmpty()) return 0;
        int sent = 0;
        while (!queued.isEmpty()) {
            int take = Math.min(FLUSH_BATCH, queued.size());
            List<String> chunk = new ArrayList<>(queued.subList(0, take));
            Result r = post(c, Heartbeat.batch(chunk));
            if (!r.ok) break;
            sent += chunk.size();
            queued.subList(0, take).clear();
            writeQueue(c, queued);
        }
        return sent;
    }

    /**
     * Send one beat. On transport/HTTP failure it is queued for the next flush.
     * Returns the HTTP result (ok=false when queued).
     */
    public static Result send(Context c, String beatJson) {
        flush(c); // try to drain anything older first
        Result r = post(c, Heartbeat.batch(beatJson));
        if (r.ok) {
            Config.bumpBeats(c);
            Config.setLastBeatAt(c, System.currentTimeMillis());
        } else {
            enqueue(c, beatJson);
        }
        return r;
    }

    public static void enqueue(Context c, String beatJson) {
        List<String> q = readQueue(c);
        q.add(beatJson);
        while (q.size() > MAX_QUEUE) q.remove(0);
        writeQueue(c, q);
    }

    public static int queueSize(Context c) {
        return readQueue(c).size();
    }

    private static Result post(Context c, String body) {
        String base = Config.baseUrl(c);
        String key = Config.apiKey(c);
        if (base.isEmpty()) return new Result(false, 0, "no server URL configured");
        if (key.isEmpty()) return new Result(false, 0, "no API key configured");

        HttpURLConnection conn = null;
        try {
            URL url = new URL(base + "/media/heartbeats");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("X-API-Key", key);
            conn.setRequestProperty("User-Agent", "watchtime-android/1.0");
            conn.setRequestProperty("Connection", "close");

            byte[] payload = body.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }

            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readAll(in);
            return new Result(code >= 200 && code < 300, code, text);
        } catch (Exception e) {
            return new Result(false, 0, e.getClass().getSimpleName() + ": " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream in) {
        if (in == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line);
                if (sb.length() > 512) break;
            }
        } catch (Exception ignored) {
        }
        return sb.toString();
    }

    private static List<String> readQueue(Context c) {
        List<String> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(Config.rawQueue(c));
            for (int i = 0; i < arr.length(); i++) out.add(arr.getString(i));
        } catch (Exception ignored) {
        }
        return out;
    }

    private static void writeQueue(Context c, List<String> beats) {
        JSONArray arr = new JSONArray();
        for (String b : beats) arr.put(b);
        Config.rawQueue(c, arr.toString());
    }
}
