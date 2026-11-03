package nz.jwsoat.watchtime;

import java.util.List;

/**
 * Builds the exact heartbeat JSON the API's {@code MediaHeartbeat} model accepts.
 *
 * <p>Deliberately dependency-free (no org.json) so the same class can be compiled
 * and run on a plain JVM to verify the payload shape against the live API.
 */
public final class Heartbeat {

    /** The platform discriminator used by the server for phone/tablet clients. */
    public static final String PLATFORM = "mobile-android";

    private Heartbeat() {}

    /** One heartbeat object (not wrapped in a batch). */
    public static String beat(long ts, String channel, String title, String state,
                              boolean tabVisible, String clientId, String displayName,
                              String mediaUser) {
        StringBuilder sb = new StringBuilder(320);
        sb.append('{')
          .append("\"ts\":").append(ts).append(',')
          .append("\"platform\":\"").append(escape(PLATFORM)).append("\",")
          .append("\"channel\":\"").append(escape(channel)).append("\",")
          .append("\"title\":").append(title == null ? "null" : "\"" + escape(title) + "\"").append(',')
          .append("\"video_id\":null,")
          .append("\"state\":\"").append(escape(state)).append("\",")
          .append("\"tab_visible\":").append(tabVisible).append(',')
          .append("\"client_id\":\"").append(escape(clientId)).append("\",")
          .append("\"media_user\":").append(mediaUser == null || mediaUser.isEmpty()
                  ? "null" : "\"" + escape(mediaUser) + "\"").append(',')
          .append("\"display_name\":").append(displayName == null ? "null" : "\"" + escape(displayName) + "\"")
          .append('}');
        return sb.toString();
    }

    /** Wrap individual heartbeat objects into the batch body the endpoint expects. */
    public static String batch(List<String> beats) {
        StringBuilder sb = new StringBuilder(64 + beats.size() * 320);
        sb.append("{\"heartbeats\":[");
        for (int i = 0; i < beats.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(beats.get(i));
        }
        sb.append("]}");
        return sb.toString();
    }

    public static String batch(String... beats) {
        StringBuilder sb = new StringBuilder("{\"heartbeats\":[");
        for (int i = 0; i < beats.length; i++) {
            if (i > 0) sb.append(',');
            sb.append(beats[i]);
        }
        return sb.append("]}").toString();
    }

    static String escape(String s) {
        StringBuilder out = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.toString();
    }
}
